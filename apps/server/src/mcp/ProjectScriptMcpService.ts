import {
  PROJECT_SCRIPT_MCP_DEFAULT_LIST_LIMIT,
  PROJECT_SCRIPT_MCP_DEFAULT_PREVIEW_CHARS,
  type ProjectScript,
  ProjectScriptMcpFailure,
  type ProjectScriptMcpListInput,
  type ProjectScriptMcpListResult,
  type ProjectScriptMcpRunInput,
  type ProjectScriptMcpRunResult,
  type ProjectScriptMcpStopInput,
  type ProjectScriptMcpStopResult,
  type TerminalMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { TerminalMcpService } from "./TerminalMcpService.ts";

const MAX_SCRIPT_INPUT_CHARS = 65_535;

interface ScriptRunOwnership {
  readonly projectId: string;
  readonly scriptId: string;
}

type ScriptRuns = ReadonlyMap<ThreadId, ReadonlyMap<string, ScriptRunOwnership>>;

export class ProjectScriptMcpService extends Context.Service<
  ProjectScriptMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: ProjectScriptMcpListInput,
    ) => Effect.Effect<ProjectScriptMcpListResult, ProjectScriptMcpFailure>;
    readonly run: (
      scope: McpInvocationScope,
      input: ProjectScriptMcpRunInput,
    ) => Effect.Effect<ProjectScriptMcpRunResult, ProjectScriptMcpFailure>;
    readonly stop: (
      scope: McpInvocationScope,
      input: ProjectScriptMcpStopInput,
    ) => Effect.Effect<ProjectScriptMcpStopResult, ProjectScriptMcpFailure>;
  }
>()("t3/mcp/ProjectScriptMcpService") {}

function failure(code: ProjectScriptMcpFailure["code"], message: string): ProjectScriptMcpFailure {
  return new ProjectScriptMcpFailure({ code, message });
}

function terminalFailure(error: TerminalMcpFailure): ProjectScriptMcpFailure {
  return failure(error.code, error.message);
}

function scriptForId(scripts: ReadonlyArray<ProjectScript>, scriptId: string) {
  return scripts.find((candidate) => candidate.id === scriptId);
}

function preview(script: ProjectScript, maxChars: number) {
  const characters = Array.from(script.command);
  return {
    scriptId: script.id,
    name: script.name,
    icon: script.icon,
    runOnWorktreeCreate: script.runOnWorktreeCreate,
    previewUrl: script.previewUrl ?? null,
    autoOpenPreview: script.autoOpenPreview ?? false,
    commandPreview: characters.slice(0, maxChars).join(""),
    commandCharacters: characters.length,
    commandTruncated: characters.length > maxChars,
  } as const;
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const terminals = yield* TerminalMcpService;
  const runs = yield* Ref.make<ScriptRuns>(new Map());

  const recordRun = (threadId: ThreadId, terminalId: string, ownership: ScriptRunOwnership) =>
    Ref.update(runs, (current) => {
      const next = new Map(current);
      next.set(threadId, new Map(current.get(threadId) ?? []).set(terminalId, ownership));
      return next;
    });

  const removeRun = (threadId: ThreadId, terminalId: string) =>
    Ref.update(runs, (current) => {
      const forThread = current.get(threadId);
      if (forThread === undefined || !forThread.has(terminalId)) return current;
      const next = new Map(current);
      const nextForThread = new Map(forThread);
      nextForThread.delete(terminalId);
      if (nextForThread.size === 0) next.delete(threadId);
      else next.set(threadId, nextForThread);
      return next;
    });

  const load = Effect.fn("ProjectScriptMcpService.load")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId | undefined,
  ) {
    return yield* terminals.resolveTarget(scope, threadId).pipe(Effect.mapError(terminalFailure));
  });

  return ProjectScriptMcpService.of({
    list: (scope, input) =>
      Effect.gen(function* () {
        const resolved = yield* load(scope, input.threadId);
        const cursor = input.cursor ?? 0;
        const limit = input.limit ?? PROJECT_SCRIPT_MCP_DEFAULT_LIST_LIMIT;
        const maxChars = input.commandPreviewChars ?? PROJECT_SCRIPT_MCP_DEFAULT_PREVIEW_CHARS;
        const page = resolved.project.scripts.slice(cursor, cursor + limit);
        return {
          threadId: resolved.target.thread.id,
          projectId: resolved.project.id,
          scripts: page.map((script) => preview(script, maxChars)),
          nextCursor:
            cursor + page.length < resolved.project.scripts.length ? cursor + page.length : null,
          total: resolved.project.scripts.length,
        };
      }),
    run: (scope, input) =>
      Effect.gen(function* () {
        const resolved = yield* load(scope, input.threadId);
        const script = scriptForId(resolved.project.scripts, input.scriptId);
        if (script === undefined) {
          return yield* failure(
            "script_not_found",
            `Saved script '${input.scriptId}' was not found in project '${resolved.project.id}'.`,
          );
        }
        if (script.command.length > MAX_SCRIPT_INPUT_CHARS) {
          return yield* failure(
            "script_command_too_large",
            `Saved script '${script.id}' exceeds the managed terminal input limit.`,
          );
        }

        const terminalId = `script-run:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
        const terminal = yield* terminals
          .openFresh(scope, { threadId: resolved.target.thread.id, terminalId })
          .pipe(Effect.mapError(terminalFailure));
        yield* recordRun(resolved.target.thread.id, terminalId, {
          projectId: resolved.project.id,
          scriptId: script.id,
        });

        const write = yield* Effect.result(
          terminals.write(scope, {
            threadId: resolved.target.thread.id,
            terminalId,
            data: `${script.command}\r`,
          }),
        );
        return Result.match(write, {
          onFailure: (error) => ({
            threadId: resolved.target.thread.id,
            projectId: resolved.project.id,
            scriptId: script.id,
            terminalId,
            outcome: "terminal_opened_input_failed" as const,
            terminal,
            inputAcceptance: null,
            error: error.message,
            previewUrl: script.previewUrl ?? null,
            previewAutoOpened: false as const,
          }),
          onSuccess: (inputAcceptance) => ({
            threadId: resolved.target.thread.id,
            projectId: resolved.project.id,
            scriptId: script.id,
            terminalId,
            outcome: "input_accepted" as const,
            terminal,
            inputAcceptance,
            error: null,
            previewUrl: script.previewUrl ?? null,
            previewAutoOpened: false as const,
          }),
        });
      }),
    stop: (scope, input) =>
      Effect.gen(function* () {
        const resolved = yield* load(scope, input.threadId);
        const script = scriptForId(resolved.project.scripts, input.scriptId);
        if (script === undefined) {
          return yield* failure(
            "script_not_found",
            `Saved script '${input.scriptId}' was not found in project '${resolved.project.id}'.`,
          );
        }
        const ownership = (yield* Ref.get(runs))
          .get(resolved.target.thread.id)
          ?.get(input.terminalId);
        if (
          ownership === undefined ||
          ownership.projectId !== resolved.project.id ||
          ownership.scriptId !== script.id
        ) {
          return yield* failure(
            "script_run_not_found",
            `Terminal '${input.terminalId}' is not a managed run of saved script '${script.id}' for thread '${resolved.target.thread.id}'.`,
          );
        }
        yield* terminals
          .close(scope, {
            threadId: resolved.target.thread.id,
            terminalId: input.terminalId,
          })
          .pipe(Effect.mapError(terminalFailure));
        yield* removeRun(resolved.target.thread.id, input.terminalId);
        return {
          threadId: resolved.target.thread.id,
          projectId: resolved.project.id,
          scriptId: script.id,
          terminalId: input.terminalId,
          stopped: true,
        };
      }),
  });
});

export const layer = Layer.effect(ProjectScriptMcpService, make);

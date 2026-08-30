import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type Project,
  type ProjectScript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import {
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ProjectScriptMcpService from "./ProjectScriptMcpService.ts";
import * as TerminalMcpService from "./TerminalMcpService.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly pid: number;
  readonly failWrite: boolean;
  killCalls = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  constructor(pid: number, failWrite: boolean) {
    this.pid = pid;
    this.failWrite = failWrite;
  }

  write(data: string): void {
    if (this.failWrite) throw new Error("script PTY write failed");
    this.writes.push(data);
  }

  resize(): void {}

  kill(): void {
    this.killCalls += 1;
    for (const listener of this.exitListeners) listener({ exitCode: 0, signal: null });
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  failNextWrite = false;

  spawn(input: PtyAdapter.PtySpawnInput): Effect.Effect<PtyAdapter.PtyProcess> {
    this.spawnInputs.push(input);
    const process = new FakePtyProcess(14_000 + this.processes.length, this.failNextWrite);
    this.failNextWrite = false;
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

function projection(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runtimeMode?: "approval-required" | "full-access";
  readonly interactionMode?: "plan" | "default";
  readonly worktreePath?: string | null;
  readonly executionCwd?: string;
}): OrchestrationV2ThreadProjection {
  const providerSessionId = `provider-session:${input.threadId}`;
  const providerThreadId = `provider-thread:${input.threadId}`;
  return {
    thread: {
      id: input.threadId,
      projectId: input.projectId,
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: input.interactionMode ?? "default",
      worktreePath: input.worktreePath ?? null,
      activeProviderThreadId: input.executionCwd === undefined ? null : providerThreadId,
      deletedAt: null,
    },
    providerThreads:
      input.executionCwd === undefined ? [] : [{ id: providerThreadId, providerSessionId }],
    providerSessions:
      input.executionCwd === undefined
        ? []
        : [{ id: providerSessionId, cwd: input.executionCwd, status: "ready" }],
  } as unknown as OrchestrationV2ThreadProjection;
}

function project(input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly scripts: ReadonlyArray<ProjectScript>;
}): Project {
  return {
    id: input.projectId,
    title: "Script project",
    workspaceRoot: input.workspaceRoot,
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [...input.scripts],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("ProjectScriptMcpService", () => {
  it.effect("runs only saved scripts in dedicated managed terminals", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-script-mcp-" });
        const workspaceRoot = path.join(baseDir, "workspace");
        const worktreePath = path.join(baseDir, "worktree");
        const nestedExecutionCwd = path.join(worktreePath, "packages", "app");
        yield* fs.makeDirectory(workspaceRoot, { recursive: true });
        yield* fs.makeDirectory(nestedExecutionCwd, { recursive: true });

        const projectId = ProjectId.make("project:script-mcp");
        const missingProjectId = ProjectId.make("project:script-mcp-missing");
        const callerThreadId = ThreadId.make("thread:script-mcp-caller");
        const targetThreadId = ThreadId.make("thread:script-mcp-target");
        const restrictedThreadId = ThreadId.make("thread:script-mcp-restricted");
        const missingProjectThreadId = ThreadId.make("thread:script-mcp-missing-project");
        const projections = new Map([
          [callerThreadId, projection({ threadId: callerThreadId, projectId })],
          [
            targetThreadId,
            projection({
              threadId: targetThreadId,
              projectId,
              worktreePath,
              executionCwd: nestedExecutionCwd,
            }),
          ],
          [
            restrictedThreadId,
            projection({
              threadId: restrictedThreadId,
              projectId,
              runtimeMode: "approval-required",
              interactionMode: "plan",
            }),
          ],
          [
            missingProjectThreadId,
            projection({ threadId: missingProjectThreadId, projectId: missingProjectId }),
          ],
        ]);
        let savedScripts: ReadonlyArray<ProjectScript> = [
          {
            id: "dev",
            name: "Development server",
            command: "pnpm run dev",
            icon: "play",
            runOnWorktreeCreate: false,
            previewUrl: "http://localhost:3000",
            autoOpenPreview: true,
          },
          {
            id: "test",
            name: "Tests",
            command: "pnpm test",
            icon: "test",
            runOnWorktreeCreate: false,
          },
        ];
        const ptyAdapter = new FakePtyAdapter();
        const manager = yield* TerminalManager.makeWithOptions({
          logsDir: path.join(baseDir, "terminal-history"),
          ptyAdapter,
          processKillGraceMs: 1,
        });
        const threads = ThreadManagementService.of({
          getThreadProjection: (threadId: ThreadId) =>
            projections.has(threadId)
              ? Effect.succeed(projections.get(threadId)!)
              : Effect.fail(new Error("missing projection") as never),
          getProjectThread: ({
            projectId: expectedProjectId,
            threadId,
          }: {
            readonly projectId: ProjectId;
            readonly threadId: ThreadId;
          }) => {
            const target = projections.get(threadId);
            return target !== undefined && target.thread.projectId === expectedProjectId
              ? Effect.succeed(target)
              : Effect.fail(
                  new ThreadManagementThreadNotFoundError({
                    projectId: expectedProjectId,
                    threadId,
                  }),
                );
          },
        } as unknown as ThreadManagementService["Service"]);
        const projects = ProjectService.ProjectService.of({
          getById: (requestedProjectId: ProjectId) =>
            Effect.succeed(
              requestedProjectId === projectId
                ? Option.some(project({ projectId, workspaceRoot, scripts: savedScripts }))
                : Option.none(),
            ),
        } as unknown as ProjectService.ProjectService["Service"]);
        const terminalService = yield* TerminalMcpService.make.pipe(
          Effect.provideService(ThreadManagementService, threads),
          Effect.provideService(ProjectService.ProjectService, projects),
          Effect.provideService(TerminalManager.TerminalManager, manager),
        );
        const service = yield* ProjectScriptMcpService.make.pipe(
          Effect.provideService(TerminalMcpService.TerminalMcpService, terminalService),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:script-mcp"),
          threadId: callerThreadId,
          providerSessionId: "provider-session:script-mcp",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };

        const page = yield* service.list(scope, {
          threadId: targetThreadId,
          limit: 1,
          commandPreviewChars: 5,
        });
        expect(page).toMatchObject({
          threadId: targetThreadId,
          projectId,
          total: 2,
          nextCursor: 1,
          scripts: [
            {
              scriptId: "dev",
              commandPreview: "pnpm ",
              commandCharacters: 12,
              commandTruncated: true,
              previewUrl: "http://localhost:3000",
              autoOpenPreview: true,
            },
          ],
        });
        assert.equal(ptyAdapter.spawnInputs.length, 0);

        const unknownScript = yield* service
          .run(scope, { threadId: targetThreadId, scriptId: "missing" })
          .pipe(Effect.flip);
        assert.equal(unknownScript.code, "script_not_found");
        const unknownThread = yield* service
          .list(scope, { threadId: ThreadId.make("thread:script-mcp-unknown") })
          .pipe(Effect.flip);
        assert.equal(unknownThread.code, "thread_not_found");
        const missingProject = yield* service
          .list({ ...scope, threadId: missingProjectThreadId }, {})
          .pipe(Effect.flip);
        assert.equal(missingProject.code, "project_not_found");
        const denied = yield* service
          .run(scope, { threadId: restrictedThreadId, scriptId: "dev" })
          .pipe(Effect.flip);
        assert.equal(denied.code, "execution_policy_denied");
        assert.equal(ptyAdapter.spawnInputs.length, 0);

        const first = yield* service.run(scope, { threadId: targetThreadId, scriptId: "dev" });
        assert.equal(first.outcome, "input_accepted");
        assert.isTrue(first.terminalId.startsWith("script-run:"));
        assert.equal(first.previewAutoOpened, false);
        expect(ptyAdapter.spawnInputs[0]).toMatchObject({
          cwd: nestedExecutionCwd,
          worktreePath,
          env: {
            T3CODE_PROJECT_ROOT: workspaceRoot,
            T3CODE_WORKTREE_PATH: worktreePath,
          },
        });
        expect(ptyAdapter.processes[0]?.writes).toEqual(["pnpm run dev\r"]);

        const second = yield* service.run(scope, { threadId: targetThreadId, scriptId: "dev" });
        assert.notEqual(second.terminalId, first.terminalId);
        assert.equal(ptyAdapter.spawnInputs.length, 2);
        expect(ptyAdapter.processes[1]?.writes).toEqual(["pnpm run dev\r"]);

        const unrelatedStop = yield* service
          .stop(scope, {
            threadId: targetThreadId,
            scriptId: "test",
            terminalId: second.terminalId,
          })
          .pipe(Effect.flip);
        assert.equal(unrelatedStop.code, "script_run_not_found");
        const stopped = yield* service.stop(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: first.terminalId,
        });
        assert.isTrue(stopped.stopped);
        assert.equal(
          yield* manager.inspectSession({ threadId: targetThreadId, terminalId: first.terminalId }),
          null,
        );

        ptyAdapter.failNextWrite = true;
        const partial = yield* service.run(scope, {
          threadId: targetThreadId,
          scriptId: "test",
        });
        assert.equal(partial.outcome, "terminal_opened_input_failed");
        assert.equal(partial.inputAcceptance, null);
        assert.match(partial.error ?? "", /write/i);
        assert.isNotNull(
          yield* manager.inspectSession({
            threadId: targetThreadId,
            terminalId: partial.terminalId,
          }),
        );
        yield* service.stop(scope, {
          threadId: targetThreadId,
          scriptId: "test",
          terminalId: partial.terminalId,
        });
        yield* service.stop(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: second.terminalId,
        });

        savedScripts = [
          ...savedScripts,
          {
            id: "too-large",
            name: "Too large",
            command: "x".repeat(65_536),
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ];
        const tooLarge = yield* service
          .run(scope, { threadId: targetThreadId, scriptId: "too-large" })
          .pipe(Effect.flip);
        assert.equal(tooLarge.code, "script_command_too_large");
        assert.equal(ptyAdapter.spawnInputs.length, 3);
      }),
    ).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
  );
});

import { assert, describe, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import {
  CreateThreadsTool,
  DelegateTaskTool,
  ScheduleTaskTool,
  ThreadForkTool,
  ThreadMergeBackTool,
  ThreadTransfersTool,
} from "./tools.ts";

describe("orchestrator MCP tool guidance", () => {
  it("directs subagent requests to delegation instead of ordinary threads", () => {
    assert.include(DelegateTaskTool.description ?? "", "child agent/subagent");
    assert.include(DelegateTaskTool.description ?? "", "cross-provider");
    assert.include(CreateThreadsTool.description ?? "", "not delegation");
    assert.include(CreateThreadsTool.description ?? "", "call delegate_task");
  });

  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    assert.isString(schema.properties?.schedule?.description);
    assert.isAtLeast(schema.properties?.schedule?.anyOf?.length ?? 0, 2);
    assert.include(ScheduleTaskTool.description ?? "", "STRUCTURED OBJECT");
    assert.include(ScheduleTaskTool.description ?? "", "nextRunAt");
  });

  it("publishes discoverable root-object schemas for conversation transfers", () => {
    const forkSchema = Tool.getJsonSchema(ThreadForkTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: ReadonlyArray<string>;
    };
    const transfersSchema = Tool.getJsonSchema(ThreadTransfersTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    const mergeSchema = Tool.getJsonSchema(ThreadMergeBackTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly required?: ReadonlyArray<string>;
    };

    assert.equal(forkSchema.type, "object");
    assert.hasAllKeys(forkSchema.properties ?? {}, [
      "sourceThreadId",
      "sourcePoint",
      "title",
      "clientRequestId",
    ]);
    assert.include(forkSchema.required ?? [], "sourcePoint");
    assert.include(forkSchema.required ?? [], "clientRequestId");
    assert.equal(transfersSchema.type, "object");
    assert.hasAllKeys(transfersSchema.properties ?? {}, ["threadId", "type", "limit"]);
    assert.equal(mergeSchema.type, "object");
    assert.hasAllKeys(mergeSchema.properties ?? {}, [
      "sourceThreadId",
      "targetThreadId",
      "sourcePoint",
      "clientRequestId",
    ]);
    assert.include(mergeSchema.required ?? [], "sourcePoint");
    assert.include(mergeSchema.required ?? [], "clientRequestId");
  });
});

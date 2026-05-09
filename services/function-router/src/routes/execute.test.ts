import { describe, expect, it } from "vitest";
import {
  buildWorkspaceCommandPayload,
  resolveWorkspaceUtilityTimeoutMs,
} from "./execute.js";

describe("workspace command routing", () => {
  it("forwards cwd to the workspace runtime", () => {
    const payload = buildWorkspaceCommandPayload({
      args: {
        workspaceRef: "swebench-sympy-20590",
        command: "git status --short",
        cwd: "/testbed",
        timeoutMs: 120000,
      },
      executionId: "exec-1",
      dbExecutionId: "db-exec-1",
      workflowId: "workflow-1",
      nodeId: "checkout_repo",
      nodeName: "checkout_repo",
    });

    expect(payload).toMatchObject({
      workspaceRef: "swebench-sympy-20590",
      command: "git status --short",
      cwd: "/testbed",
      timeoutMs: 120000,
    });
  });

  it("accepts workingDir aliases for browser/workspace callers", () => {
    const payload = buildWorkspaceCommandPayload({
      args: {
        workspaceRef: "workspace-1",
        prompt: "pwd",
        workingDirectory: "/sandbox/app",
      },
      executionId: "exec-1",
      workflowId: "workflow-1",
      nodeId: "command",
      nodeName: "command",
    });

    expect(payload).toMatchObject({
      workspaceRef: "workspace-1",
      command: "pwd",
      cwd: "/sandbox/app",
    });
  });
});

describe("workspace utility timeout routing", () => {
  it("honors long workspace/profile timeout budgets for Kueue-backed sandboxes", () => {
    expect(
      resolveWorkspaceUtilityTimeoutMs({
        toolId: "profile",
        timeoutMs: 2_100_000,
        commandTimeoutMs: undefined,
      }),
    ).toBe(2_100_000);
  });

  it("still caps workspace/profile timeout budgets at the utility ceiling", () => {
    expect(
      resolveWorkspaceUtilityTimeoutMs({
        toolId: "profile",
        timeoutMs: 9_000_000,
        commandTimeoutMs: undefined,
      }),
    ).toBe(3_600_000);
  });
});

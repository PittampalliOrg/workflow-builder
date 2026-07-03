import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  GoalCompletionEvaluator,
  type GoalCompletionEvaluatorDependencies,
} from "$lib/server/goals/evaluator";
import type {
  SessionGoalRecord,
  WorkflowWorkspaceSessionRecord,
} from "$lib/server/application/ports";
import type { SessionDetail } from "$lib/types/sessions";

describe("GoalCompletionEvaluator", () => {
  it("keeps self-judged completion behavior for goals without evidence", async () => {
    const deps = fakeDeps({
      goal: sampleGoal({ evidencePlan: null }),
    });

    const result = await new GoalCompletionEvaluator(
      deps,
    ).evaluateGoalCompletion("session-1");

    expect(result).toEqual({
      met: true,
      skipped: true,
      results: [],
      feedback:
        "No evidence commands declared; accepting self-judged completion.",
    });
    expect(
      deps.workflowData.listWorkflowWorkspaceSessionsByExecutionId,
    ).not.toHaveBeenCalled();
    expect(deps.runEvidenceCommand).not.toHaveBeenCalled();
  });

  it("runs workflow-driven evidence against the workflow-data workspace session", async () => {
    const deps = fakeDeps({
      goal: sampleGoal({
        evidencePlan: { commands: ["pnpm check"] },
        workflowExecutionId: "exec-1",
      }),
      workspaceSessions: [
        sampleWorkspaceSession({
          workspaceRef: "workspace-1",
          rootPath: "/sandbox/work",
        }),
      ],
    });

    const result = await new GoalCompletionEvaluator(
      deps,
    ).evaluateGoalCompletion("session-1");

    expect(result.met).toBe(true);
    expect(result.feedback).toBe("All 1 evidence check(s) passed.");
    expect(
      deps.workflowData.listWorkflowWorkspaceSessionsByExecutionId,
    ).toHaveBeenCalledWith({ executionId: "exec-1", limit: 1 });
    expect(deps.runEvidenceCommand).toHaveBeenCalledWith(
      {
        kind: "openshell",
        executionId: "exec-1",
        workspaceRef: "workspace-1",
        rootPath: "/sandbox/work",
      },
      "pnpm check",
    );
  });

  it("falls back to session detail for direct non-workflow sessions", async () => {
    const deps = fakeDeps({
      goal: sampleGoal({
        evidencePlan: { commands: ["pytest -q"] },
        workflowExecutionId: null,
      }),
      session: sampleSession({ workspaceSandboxName: "workspace-sandbox-1" }),
    });

    await new GoalCompletionEvaluator(deps).evaluateGoalCompletion("session-1");

    expect(deps.workflowData.getSessionDetail).toHaveBeenCalledWith({
      sessionId: "session-1",
    });
    expect(deps.runEvidenceCommand).toHaveBeenCalledWith(
      {
        kind: "openshell",
        executionId: "session-1",
        workspaceRef: "workspace-sandbox-1",
        rootPath: "/sandbox",
      },
      "pytest -q",
    );
  });

  it("runs interactive CLI evidence in the CLI host instead of openshell", async () => {
    const deps = fakeDeps({
      goal: sampleGoal({
        evidencePlan: { commands: ["npm test"] },
        workflowExecutionId: "exec-1",
      }),
      runtimeDebugTarget: {
        appId: "agent-session-abc",
        invokeTarget: "agent-session-abc",
        runtimeSandboxName: null,
        source: "persisted",
        agentSlug: "codex",
        agentRuntime: "codex-cli",
      },
    });

    await new GoalCompletionEvaluator(deps).evaluateGoalCompletion("session-1");

    expect(
      deps.workflowData.listWorkflowWorkspaceSessionsByExecutionId,
    ).not.toHaveBeenCalled();
    expect(deps.waitForAgentWorkflowHostAppReady).toHaveBeenCalledWith({
      agentAppId: "agent-session-abc",
    });
    expect(deps.runEvidenceCommand).toHaveBeenCalledWith(
      {
        kind: "cli-direct",
        baseUrl: "http://agent-host:8002",
        rootPath: "/sandbox",
      },
      "npm test",
    );
  });

  it("does not import direct DB or legacy session helpers", () => {
    const source = readFileSync(
      new URL("./evaluator.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toContain("drizzle-orm");
    expect(source).not.toContain("workflowWorkspaceSessions");
    expect(source).not.toContain("$lib/server/sessions/registry");
    expect(source).not.toContain("./repo");
  });
});

function fakeDeps(
  input: {
    goal?: SessionGoalRecord | null;
    workspaceSessions?: WorkflowWorkspaceSessionRecord[];
    session?: SessionDetail | null;
    runtimeDebugTarget?: Awaited<
      ReturnType<
        GoalCompletionEvaluatorDependencies["workflowData"]["getSessionRuntimeDebugTarget"]
      >
    >;
  } = {},
): GoalCompletionEvaluatorDependencies {
  return {
    goals: {
      getCurrentGoal: vi.fn(async () => input.goal ?? sampleGoal()),
    },
    workflowData: {
      getSessionDetail: vi.fn(async () => input.session ?? sampleSession()),
      getSessionRuntimeDebugTarget: vi.fn(
        async () => input.runtimeDebugTarget ?? null,
      ),
      listWorkflowWorkspaceSessionsByExecutionId: vi.fn(
        async () => input.workspaceSessions ?? [],
      ),
    },
    waitForAgentWorkflowHostAppReady: vi.fn(async () => ({
      ok: true as const,
      attempts: 1,
      status: 200,
      baseUrl: "http://agent-host:8002",
      podName: "agent-host-pod",
      podIP: "10.0.0.1",
    })),
    runEvidenceCommand: vi.fn(async (_target, command) => ({
      command,
      exitCode: 0,
      ok: true,
      output: "ok",
    })),
  };
}

function sampleGoal(
  overrides: Partial<SessionGoalRecord> = {},
): SessionGoalRecord {
  return {
    id: "goal-row-1",
    sessionId: "session-1",
    goalId: "goal-1",
    objective: "ship it",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    iterations: 0,
    maxIterations: 50,
    acceptanceCriteria: null,
    evidencePlan: { commands: ["true"] },
    budgetSteeredAt: null,
    lastContinuationAt: null,
    stopReason: null,
    workflowExecutionId: "exec-1",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    completedAt: null,
    ...overrides,
  };
}

function sampleWorkspaceSession(
  overrides: Partial<WorkflowWorkspaceSessionRecord> = {},
): WorkflowWorkspaceSessionRecord {
  return {
    workspaceRef: "workspace-1",
    workflowExecutionId: "exec-1",
    rootPath: "/sandbox",
    status: "active",
    sandboxState: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function sampleSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "session-1",
    title: "Session 1",
    status: "idle",
    stopReason: null,
    agentId: "agent-1",
    agentVersion: 1,
    projectId: "project-1",
    environmentId: null,
    environmentVersion: null,
    vaultIds: [],
    usage: {},
    errorMessage: null,
    workflowExecutionId: null,
    mlflowExperimentId: null,
    mlflowRunId: null,
    mlflowParentRunId: null,
    mlflowSessionId: null,
    workflowId: null,
    workflowName: null,
    agentName: "Agent 1",
    agentSlug: "agent-1",
    agentAvatar: null,
    agentEphemeral: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    daprInstanceId: null,
    natsSubject: null,
    parentExecutionId: null,
    resumedFromSessionId: null,
    sandboxName: "runtime-sandbox-1",
    workspaceSandboxName: null,
    runtimeAppId: null,
    runtimeSandboxName: null,
    pausedAt: null,
    ...overrides,
  };
}

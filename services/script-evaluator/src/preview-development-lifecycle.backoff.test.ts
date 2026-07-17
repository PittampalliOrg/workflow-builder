import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateScript } from "./sandbox.js";

const script = readFileSync(
  new URL(
    "../../../scripts/fixtures/dynamic-scripts/preview-development-lifecycle.js",
    import.meta.url,
  ),
  "utf8",
);

const target = {
  previewName: "feature-one",
  environmentRequestId: "request-1",
  platformRevision: "a".repeat(40),
  sourceRevision: "b".repeat(40),
  catalogDigest: `sha256:${"c".repeat(64)}`,
};
const promotionReceiptId = `pspr_${"e".repeat(64)}`;

// Mirrors the fixture's deterministic schedule so the assertions stay exact.
function pollDelaySeconds(attempt: number, capSeconds: number): number {
  let delay = 5;
  for (let i = 0; i < attempt && delay < capSeconds; i += 1) {
    delay = Math.min(delay * 1.5, capSeconds);
  }
  return delay;
}

function attemptsForBudget(budgetSeconds: number, capSeconds: number): number {
  let elapsed = 0;
  let sleeps = 0;
  while (elapsed < budgetSeconds) {
    elapsed += pollDelaySeconds(sleeps, capSeconds);
    sleeps += 1;
  }
  return sleeps + 1;
}

function terminalOutput() {
  return {
    controlOutcome: "submitted",
    pullRequestReceipt: {
      ok: true,
      receiptId: promotionReceiptId,
      previewName: target.previewName,
      requestId: target.environmentRequestId,
      executionId: "child-1",
      services: ["workflow-builder"],
      branch: "preview-feature-verified",
      commitSha: "e".repeat(40),
      prUrl: "https://github.com/PittampalliOrg/workflow-builder/pull/42",
      pullRequest: {
        repository: "PittampalliOrg/workflow-builder",
        number: 42,
        baseSha: "b".repeat(40),
        headSha: "e".repeat(40),
      },
      draft: true,
    },
  };
}

async function drive(
  options: {
    services?: string[];
    runningPolls?: number;
    environmentNeverReady?: boolean;
  } = {},
) {
  const args = {
    intent: "Add a deployment health panel",
    environmentName: "feature-one",
    services: options.services ?? ["workflow-builder"],
    ttlHours: 8,
    retainAfterCompletion: false,
  };
  const completedResults: Record<
    string,
    | { status: "done"; value: unknown }
    | { status: "error"; value: unknown; errorCode?: string }
  > = {};
  const knownCallIds: string[] = [];
  const tasks: Array<Record<string, unknown>> = [];
  let result = await evaluateScript({
    script,
    args,
    budget: { total: 1_000_000, spent: 0 },
    completedResults,
    knownCallIds,
    seenLogCount: 0,
    features: { actions: true },
  });

  for (let round = 0; result.status === "need" && round < 2_000; round += 1) {
    expect(result.tasks.length).toBeGreaterThan(0);
    for (const task of result.tasks) {
      tasks.push(task as unknown as Record<string, unknown>);
      let value: unknown;
      if (task.kind === "sleep") {
        value = null;
      } else {
        switch (task.actionSlug) {
          case "preview/environment-launch":
            value = { ok: true, phase: "Provisioning", target };
            break;
          case "preview/environment-status":
            value = options.environmentNeverReady
              ? { ok: true, phase: "Provisioning", ready: false, target }
              : { ok: true, phase: "Ready", ready: true, target };
            break;
          case "preview/workflow-start":
            value = {
              ok: true,
              executionId: "child-1",
              workflowSpecDigest: `sha256:${"d".repeat(64)}`,
              status: "running",
            };
            break;
          case "preview/workflow-status": {
            const previousStatuses = tasks.filter(
              (entry) => entry.actionSlug === "preview/workflow-status",
            ).length;
            value =
              previousStatuses <= (options.runningPolls ?? 0)
                ? { ok: true, status: "running", controlReady: false }
                : {
                    ok: true,
                    status: "completed",
                    terminal: true,
                    output: terminalOutput(),
                  };
            break;
          }
          case "preview/workflow-verify-promotion":
            value = {
              kind: "verify-promotion",
              operationId: `pdt-verify-promotion-${"f".repeat(64)}`,
              target,
              executionId: "child-1",
              verified: true,
              receipt: {
                ok: true,
                receiptId: promotionReceiptId,
                previewName: target.previewName,
                requestId: target.environmentRequestId,
                executionId: "child-1",
                artifactId: "artifact-1",
                services: ["workflow-builder"],
                branch: "preview-feature-verified",
                commitSha: "e".repeat(40),
                prUrl:
                  "https://github.com/PittampalliOrg/workflow-builder/pull/42",
                pullRequest: {
                  repository: "PittampalliOrg/workflow-builder",
                  number: 42,
                  baseSha: "b".repeat(40),
                  headSha: "e".repeat(40),
                },
                draft: true,
              },
            };
            break;
          case "preview/environment-teardown":
            value = { ok: true, complete: true, ticket: null };
            break;
          default:
            throw new Error(
              `unexpected task ${task.kind}:${task.actionSlug ?? ""}`,
            );
        }
      }
      completedResults[task.callId] = { status: "done", value };
      knownCallIds.push(task.callId);
    }
    result = await evaluateScript({
      script,
      args,
      budget: { total: 1_000_000, spent: 0 },
      completedResults,
      knownCallIds,
      seenLogCount: 0,
      features: { actions: true },
    });
  }
  return { result, tasks };
}

function sleepSeconds(tasks: Array<Record<string, unknown>>): number[] {
  return tasks
    .filter((task) => task.kind === "sleep")
    .map((task) => task.seconds as number);
}

describe("host preview development lifecycle poll backoff", () => {
  it("rejects a multi-service request before any environment is provisioned", async () => {
    const { result, tasks } = await drive({
      services: ["workflow-builder", "function-router"],
    });
    expect(result.status).toBe("script_error");
    expect(result.error?.message).toContain(
      "multi-service preview development is not yet supported: only 1 service may be requested (got 2)",
    );
    expect(tasks).toHaveLength(0);
  });

  it("polls the child with deterministic exponential backoff capped at 60s", async () => {
    const { result, tasks } = await drive({ runningPolls: 8 });
    expect(result.status, result.error?.message).toBe("done");
    // The only sleeps in this run belong to the child observation loop.
    expect(sleepSeconds(tasks)).toEqual([
      5, 7.5, 11.25, 16.875, 25.3125, 37.96875, 56.953125, 60,
    ]);
  });

  it("preserves the ~20-minute provision budget with far fewer attempts", async () => {
    const expectedAttempts = attemptsForBudget(20 * 60, 30);
    expect(expectedAttempts).toBeLessThan(60); // was a flat 241
    const { result, tasks } = await drive({ environmentNeverReady: true });
    expect(result.status).toBe("script_error");
    expect(result.error?.message).toContain(
      `preview/environment-status timed out after ${expectedAttempts} observations`,
    );
    expect(
      tasks.filter((task) => task.actionSlug === "preview/environment-status"),
    ).toHaveLength(expectedAttempts);
    const sleeps = sleepSeconds(tasks);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30);
    expect(sleeps.reduce((sum, value) => sum + value, 0)).toBeGreaterThanOrEqual(
      20 * 60,
    );
  });

  it("sizes the child observation window from the documented child budget", async () => {
    // 3 iterations x 35min agent timeout + 15min snapshot/promote overhead.
    const childBudgetSeconds = (3 * 35 + 15) * 60;
    const expectedAttempts = attemptsForBudget(childBudgetSeconds, 60);
    const { result, tasks } = await drive({
      runningPolls: Number.MAX_SAFE_INTEGER,
    });
    expect(result.status).toBe("script_error");
    expect(result.error?.message).toContain(
      `preview/workflow-status timed out after ${expectedAttempts} observations`,
    );
    expect(
      tasks.filter((task) => task.actionSlug === "preview/workflow-status"),
    ).toHaveLength(expectedAttempts);
    const childSleeps = sleepSeconds(tasks);
    expect(Math.max(...childSleeps)).toBeLessThanOrEqual(60);
    expect(
      childSleeps.reduce((sum, value) => sum + value, 0),
    ).toBeGreaterThanOrEqual(childBudgetSeconds);
    // Each poll costs 2 engine calls (action + sleep); the whole worst-case run
    // must stay inside the engine's hard 500-action-call budget.
    expect(tasks.length).toBeLessThan(500);
  });
});

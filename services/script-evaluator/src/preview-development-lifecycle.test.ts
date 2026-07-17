import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateScript, validateScript } from "./sandbox.js";

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

function terminalOutput(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

async function drive(
  options: {
    teardownAlreadyComplete?: boolean;
    terminalOutput?: Record<string, unknown>;
    ttlHours?: number;
    runningPolls?: number;
    transientStatusFailures?: number;
    promotionVerification?: Record<string, unknown>;
  } = {},
) {
  const completedResults: Record<
    string,
    | { status: "done"; value: unknown }
    | { status: "error"; value: unknown; errorCode?: string }
  > = {};
  const knownCallIds: string[] = [];
  const tasks: Array<Record<string, unknown>> = [];
  let statusFailures = 0;
  let result = await evaluateScript({
    script,
    args: {
      intent: "Add a deployment health panel",
      environmentName: "feature-one",
      services: ["workflow-builder"],
      ttlHours: options.ttlHours ?? 8,
      retainAfterCompletion: false,
    },
    budget: { total: 1_000_000, spent: 0 },
    completedResults,
    knownCallIds,
    seenLogCount: 0,
    features: { actions: true },
  });

  for (let round = 0; result.status === "need" && round < 1_000; round += 1) {
    expect(result.tasks.length).toBeGreaterThan(0);
    for (const task of result.tasks) {
      tasks.push(task as unknown as Record<string, unknown>);
      let value: unknown;
      let status: "done" | "error" = "done";
      let errorCode: string | undefined;
      if (task.kind === "sleep") {
        value = null;
      } else if (task.kind === "event") {
        throw new Error("host lifecycle should not wait for manual approval");
      } else {
        switch (task.actionSlug) {
          case "preview/environment-launch":
            value = { ok: true, phase: "Provisioning", target };
            break;
          case "preview/environment-status":
            value = { ok: true, phase: "Ready", ready: true, target };
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
            if (statusFailures < (options.transientStatusFailures ?? 0)) {
              statusFailures += 1;
              status = "error";
              errorCode = "action_error";
              value = {
                message: "preview development endpoint returned HTTP 409",
              };
              break;
            }
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
                    output: options.terminalOutput ?? terminalOutput(),
                  };
            break;
          }
          case "preview/workflow-verify-promotion":
            value =
              options.promotionVerification ??
              ({
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
              } as const);
            break;
          case "preview/environment-teardown":
            value = options.teardownAlreadyComplete
              ? { ok: true, complete: true, ticket: null }
              : {
                  ok: true,
                  ticket: {
                    name: target.previewName,
                    environmentUid: "uid-1",
                    requestId: target.environmentRequestId,
                    sourceRevision: target.sourceRevision,
                    signature: "e".repeat(64),
                  },
                };
            break;
          case "preview/environment-teardown-status":
            value = {
              ok: true,
              status: "complete",
              cleanup: { complete: true },
            };
            break;
          default:
            throw new Error(
              `unexpected task ${task.kind}:${task.actionSlug ?? ""}`,
            );
        }
      }
      completedResults[task.callId] =
        status === "done"
          ? { status: "done", value }
          : { status: "error", value, errorCode };
      knownCallIds.push(task.callId);
    }
    result = await evaluateScript({
      script,
      args: {
        intent: "Add a deployment health panel",
        environmentName: "feature-one",
        services: ["workflow-builder"],
        ttlHours: options.ttlHours ?? 8,
        retainAfterCompletion: false,
      },
      budget: { total: 1_000_000, spent: 0 },
      completedResults,
      knownCallIds,
      seenLogCount: 0,
      features: { actions: true },
    });
  }
  return { result, tasks };
}

describe("host preview development lifecycle", () => {
  it("validates with required task intent and environment inputs", async () => {
    const result = await validateScript(script);
    expect(result.ok, result.error).toBe(true);
    expect(result.meta).toMatchObject({
      name: "preview-development-lifecycle",
      input: { required: ["intent", "environmentName"] },
    });
  });

  it("starts the automated child, verifies its draft PR receipt, and tears down", async () => {
    const { result, tasks } = await drive();
    expect(result.status, result.error?.message).toBe("done");
    expect(
      tasks
        .filter((task) => task.kind === "action")
        .map((task) => task.actionSlug),
    ).toEqual([
      "preview/environment-launch",
      "preview/environment-status",
      "preview/workflow-start",
      "preview/workflow-status",
      "preview/workflow-verify-promotion",
      "preview/environment-teardown",
      "preview/environment-teardown-status",
    ]);
    expect(tasks.some((task) => task.kind === "event")).toBe(false);
    const start = tasks.find(
      (task) => task.actionSlug === "preview/workflow-start",
    );
    expect(start?.args).toMatchObject({
      target,
      intent: "Add a deployment health panel",
      services: ["workflow-builder"],
    });
    expect(start?.args).not.toHaveProperty("agentSlug");
    expect(result.returnValue).toMatchObject({
      retained: false,
      outcome: {
        output: {
          controlOutcome: "submitted",
          pullRequestReceipt: { receiptId: promotionReceiptId, draft: true },
        },
      },
      promotionVerification: {
        verified: true,
        receipt: { receiptId: promotionReceiptId, draft: true },
      },
      cleanup: { cleanup: { complete: true } },
    });
  });

  it("retries transient workflow status conflicts before teardown", async () => {
    const { result, tasks } = await drive({
      transientStatusFailures: 3,
      runningPolls: 2,
    });
    expect(result.status, result.error?.message).toBe("done");
    expect(
      tasks.filter((task) => task.actionSlug === "preview/workflow-status"),
    ).toHaveLength(6);
    expect(
      tasks.filter(
        (task) => task.actionSlug === "preview/workflow-verify-promotion",
      ),
    ).toHaveLength(1);
  });

  it("accepts an already-absent environment without polling a null teardown ticket", async () => {
    const { result, tasks } = await drive({
      teardownAlreadyComplete: true,
    });
    expect(result.status).toBe("done");
    expect(
      tasks.some(
        (task) => task.actionSlug === "preview/environment-teardown-status",
      ),
    ).toBe(false);
    expect(result.returnValue).toMatchObject({
      teardown: { complete: true, ticket: null },
      cleanup: { complete: true, ticket: null },
    });
  });

  it.each([
    ["snapshot failure", { controlOutcome: "snapshot_failed" }],
    ["promotion failure", { controlOutcome: "promotion_failed" }],
    [
      "malformed PR receipt",
      terminalOutput({
        pullRequestReceipt: {
          ok: true,
          receiptId: promotionReceiptId,
          draft: false,
        },
      }),
    ],
  ])("fails the parent after cleanup on %s", async (_label, output) => {
    const { result, tasks } = await drive({ terminalOutput: output });
    expect(result.status).toBe("script_error");
    expect(
      tasks.some((task) => task.actionSlug === "preview/environment-teardown"),
    ).toBe(true);
    expect(result.error?.message).toContain(
      "did not produce an authoritative draft pull request receipt",
    );
  });

  it("fails after cleanup when physical receipt verification is missing or mismatched", async () => {
    const { result, tasks } = await drive({
      promotionVerification: {
        kind: "verify-promotion",
        verified: true,
        target,
        executionId: "child-1",
        receipt: {
          ok: true,
          receiptId: promotionReceiptId,
          previewName: target.previewName,
          requestId: target.environmentRequestId,
          executionId: "child-1",
          artifactId: "artifact-1",
          services: ["function-router"],
          branch: "preview-feature-forged",
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
      },
    });
    expect(result.status).toBe("script_error");
    expect(result.error?.message).toContain(
      "physical preview promotion verification did not return the exact durable draft pull request receipt",
    );
    expect(
      tasks.some((task) => task.actionSlug === "preview/environment-teardown"),
    ).toBe(true);
  });
});

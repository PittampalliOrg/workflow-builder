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

async function drive(
  approved: boolean,
  options: {
    teardownAlreadyComplete?: boolean;
    terminalOutput?: Record<string, unknown>;
    ttlHours?: number;
    childReadyPolls?: number;
    transientControlSignalFailures?: number;
    transientPostSignalStatusFailures?: number;
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
  let signaled = false;
  let controlSignalFailures = 0;
  let postSignalStatusFailures = 0;
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
      if (task.kind === "event") {
        value = { approved, approvedBy: "user-1" };
      } else if (task.kind === "sleep") {
        value = null;
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
            const previousStatuses = tasks.filter(
              (entry) => entry.actionSlug === "preview/workflow-status",
            ).length;
            value =
              previousStatuses <= (options.childReadyPolls ?? 0)
                ? { ok: true, status: "running", controlReady: false }
                : previousStatuses === (options.childReadyPolls ?? 0) + 1
                  ? {
                      ok: true,
                      status: "control-ready",
                      controlReady: true,
                      sessionId: "session-1",
                      sessionUrl:
                        "https://wfb-feature-one.tail286401.ts.net/workspaces/workspace-one/sessions/session-1",
                    }
                  : {
                      ok: true,
                      status: approved ? "completed" : "discarded",
                      terminal: true,
                      output:
                        options.terminalOutput ??
                        (approved
                          ? {
                              controlOutcome: "submitted",
                              pullRequest: {
                                repository: "PittampalliOrg/workflow-builder",
                                number: 42,
                              },
                              pullRequestReceipt: {
                                ok: true,
                                receiptId: promotionReceiptId,
                                previewName: target.previewName,
                                requestId: target.environmentRequestId,
                                executionId: "child-1",
                                services: ["workflow-builder"],
                                branch: "preview/feature-one",
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
                            }
                          : {
                              controlAction: "discard",
                              controlOutcome: "discarded",
                              pullRequest: null,
                              pullRequestReceipt: null,
                          }),
                    };
            if (
              signaled &&
              postSignalStatusFailures <
                (options.transientPostSignalStatusFailures ?? 0)
            ) {
              postSignalStatusFailures += 1;
              status = "error";
              errorCode = "action_error";
              value = {
                message: "preview development endpoint returned HTTP 409",
              };
            }
            break;
          }
          case "preview/workflow-signal":
            if (
              controlSignalFailures <
              (options.transientControlSignalFailures ?? 0)
            ) {
              controlSignalFailures += 1;
              status = "error";
              errorCode = "action_error";
              value = {
                message: "preview development endpoint returned HTTP 409",
              };
            } else {
              value = { ok: true, accepted: true };
              signaled = true;
            }
            break;
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

  it("propagates intent, submits only the typed PR signal, and tears down", async () => {
    const { result, tasks } = await drive(true);
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
      "preview/workflow-signal",
      "preview/workflow-status",
      "preview/workflow-verify-promotion",
      "preview/environment-teardown",
      "preview/environment-teardown-status",
    ]);
    const launch = tasks.find(
      (task) => task.actionSlug === "preview/environment-launch",
    );
    expect(launch?.args).toEqual({
      environmentName: "feature-one",
      services: ["workflow-builder"],
      ttlHours: 8,
      retainAfterCompletion: false,
    });
    expect(JSON.stringify(launch?.args)).not.toContain("userId");
    expect(JSON.stringify(launch?.args)).not.toContain("Revision");
    const start = tasks.find(
      (task) => task.actionSlug === "preview/workflow-start",
    );
    expect(start?.args).toMatchObject({
      target,
      intent: "Add a deployment health panel",
      services: ["workflow-builder"],
      agentSlug: "glm-juicefs-builder-agent",
    });
    const signal = tasks.find(
      (task) => task.actionSlug === "preview/workflow-signal",
    );
    expect(signal?.args).toMatchObject({ action: "submit_preview_pr" });
    const approval = tasks.find((task) => task.kind === "event");
    expect(approval?.eventOpts).toMatchObject({
      message: expect.stringContaining(
        "https://wfb-feature-one.tail286401.ts.net/workspaces/workspace-one/sessions/session-1",
      ),
    });
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

  it("maps rejection to discard and never submits a PR", async () => {
    const { result, tasks } = await drive(false);
    expect(result.status).toBe("done");
    const signal = tasks.find(
      (task) => task.actionSlug === "preview/workflow-signal",
    );
    expect(signal?.args).toMatchObject({ action: "discard" });
  });

  it("retries transient post-signal status conflicts before teardown", async () => {
    const { result, tasks } = await drive(true, {
      transientPostSignalStatusFailures: 30,
    });
    expect(result.status, result.error?.message).toBe("done");
    expect(
      tasks.filter((task) => task.actionSlug === "preview/workflow-status"),
    ).toHaveLength(32);
    expect(
      tasks
        .filter((task) => task.actionSlug === "preview/workflow-verify-promotion")
        .length,
    ).toBe(1);
    expect(result.returnValue).toMatchObject({
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
    });
  });

  it("retries transient control-signal conflicts before teardown", async () => {
    const { result, tasks } = await drive(true, {
      transientControlSignalFailures: 3,
    });
    expect(result.status, result.error?.message).toBe("done");
    expect(
      tasks.filter((task) => task.actionSlug === "preview/workflow-signal"),
    ).toHaveLength(4);
    expect(
      tasks.findIndex(
        (task) => task.actionSlug === "preview/environment-teardown",
      ),
    ).toBeGreaterThan(
      tasks.findLastIndex(
        (task) => task.actionSlug === "preview/workflow-status",
      ),
    );
    expect(result.returnValue).toMatchObject({
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
    });
  });

  it("allows more than the former 20 minute startup polling budget", async () => {
    const { result, tasks } = await drive(false, { childReadyPolls: 242 });
    expect(result.status, result.error?.message).toBe("done");
    expect(
      tasks.filter((task) => task.actionSlug === "preview/workflow-status"),
    ).toHaveLength(244);
  });

  it("bounds approval below a two-hour environment TTL", async () => {
    const { result, tasks } = await drive(false, { ttlHours: 2 });
    expect(result.status).toBe("done");
    const approval = tasks.find((task) => task.kind === "event");
    expect(approval?.eventOpts).toMatchObject({ timeoutMinutes: 10 });
  });

  it("accepts an already-absent environment without polling a null teardown ticket", async () => {
    const { result, tasks } = await drive(false, {
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
      {
        controlOutcome: "submitted",
        pullRequestReceipt: {
          ok: true,
          receiptId: promotionReceiptId,
          draft: false,
        },
      },
    ],
  ])("fails the parent after cleanup on %s", async (_label, terminalOutput) => {
    const { result, tasks } = await drive(true, { terminalOutput });
    expect(result.status).toBe("script_error");
    expect(
      tasks.some((task) => task.actionSlug === "preview/environment-teardown"),
    ).toBe(true);
    expect(result.error?.message).toContain(
      "did not produce an authoritative draft pull request receipt",
    );
  });

  it("fails after cleanup when physical receipt verification is missing or mismatched", async () => {
    const { result, tasks } = await drive(true, {
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

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateScript, validateScript } from "./sandbox.js";

const script = readFileSync(
  new URL(
    "../../../scripts/fixtures/dynamic-scripts/preview-ui-development-gan.js",
    import.meta.url,
  ),
  "utf8",
);

const previewUrl = "https://preview.example.test";
const syncUrl = "http://10.0.0.5:8092/__sync";
const syncCapability = "a".repeat(64);
const promotionReceipt = {
  ok: true,
  draft: true,
  receiptId: `pspr_${"e".repeat(64)}`,
  pullRequest: {
    repository: "PittampalliOrg/workflow-builder",
    number: 42,
    baseSha: "b".repeat(40),
    headSha: "e".repeat(40),
  },
};

async function drive(
  extraArgs: Record<string, unknown> = {},
  options: {
    freezeResult?: Record<string, unknown>;
  } = {},
) {
  const args = {
    intent: "Add a preview development status panel",
    ...extraArgs,
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

  for (let round = 0; result.status === "need" && round < 1_000; round += 1) {
    expect(result.tasks.length).toBeGreaterThan(0);
    for (const task of result.tasks) {
      tasks.push(task as unknown as Record<string, unknown>);
      let value: unknown;
      if (task.kind === "sleep") {
        value = null;
      } else if (task.kind === "agent") {
        value = "implemented the dashboard enhancement and pushed one HMR generation";
      } else if (task.kind === "action") {
        switch (task.actionSlug) {
          case "dev/preview":
            value = {
              ok: true,
              url: previewUrl,
              services: [
                {
                  service: "workflow-builder",
                  info: { url: previewUrl, syncUrl, syncCapability },
                },
              ],
            };
            break;
          case "dev/preview-snapshot":
            value = { ok: true, artifactId: "artifact-1" };
            break;
          case "dev/preview-promote":
            value = promotionReceipt;
            break;
          case "dev/preview-freeze":
            value = options.freezeResult ?? { ok: true, frozen: true };
            break;
          case "session/spawn":
            value = {
              sessionId: "sess-1",
              url: "https://session.example.test/sess-1",
            };
            break;
          default:
            throw new Error(`unexpected action ${String(task.actionSlug)}`);
        }
      } else {
        throw new Error(`unexpected task kind ${String(task.kind)}`);
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

function actionSlugs(tasks: Array<Record<string, unknown>>) {
  return tasks
    .filter((task) => task.kind === "action")
    .map((task) => task.actionSlug);
}

function previewTask(tasks: Array<Record<string, unknown>>) {
  return tasks.find((task) => task.actionSlug === "dev/preview");
}

describe("preview UI development GAN child fixture", () => {
  it("validates with the additive retain/handoff inputs", async () => {
    const result = await validateScript(script);
    expect(result.ok, result.error).toBe(true);
    expect(result.meta).toMatchObject({
      name: "preview-ui-development-gan",
      input: { required: ["intent"] },
    });
  });

  it("keeps today's behavior byte-for-byte when the new inputs are absent", async () => {
    const { result, tasks } = await drive();
    expect(result.status, result.error?.message).toBe("done");
    expect(actionSlugs(tasks)).toEqual([
      "dev/preview",
      "dev/preview-snapshot",
      "dev/preview-promote",
    ]);
    expect(previewTask(tasks)?.args).toMatchObject({ timeoutSeconds: 86400 });
    const output = result.returnValue as Record<string, unknown>;
    expect(output).toMatchObject({
      controlAction: "submit_preview_pr",
      controlOutcome: "submitted",
      accepted: true,
    });
    expect(output).not.toHaveProperty("retainAfterCompletion");
    expect(output).not.toHaveProperty("freezeOutcome");
    expect(output).not.toHaveProperty("handoff");
    expect(output).not.toHaveProperty("sessionId");
    expect(output).not.toHaveProperty("sessionUrl");
  });

  it("derives the sandbox timeout from ttlHours when retaining", async () => {
    const { result, tasks } = await drive({
      retainAfterCompletion: true,
      ttlHours: 6,
    });
    expect(result.status, result.error?.message).toBe("done");
    expect(previewTask(tasks)?.args).toMatchObject({ timeoutSeconds: 21600 });
    expect(result.returnValue).toMatchObject({
      retainAfterCompletion: true,
      ttlHours: 6,
      sandboxTimeoutSeconds: 21600,
    });
  });

  it("clamps the retained lifetime to the platform sandbox ceiling", async () => {
    const { result, tasks } = await drive({
      retainAfterCompletion: true,
      ttlHours: 24,
    });
    expect(result.status, result.error?.message).toBe("done");
    expect(previewTask(tasks)?.args).toMatchObject({ timeoutSeconds: 86400 });
    expect(result.returnValue).toMatchObject({ sandboxTimeoutSeconds: 86400 });
  });

  it("freezes live-sync after promotion on retain without handoff", async () => {
    const { result, tasks } = await drive({ retainAfterCompletion: true });
    expect(result.status, result.error?.message).toBe("done");
    expect(actionSlugs(tasks)).toEqual([
      "dev/preview",
      "dev/preview-snapshot",
      "dev/preview-promote",
      "dev/preview-freeze",
    ]);
    const freeze = tasks.find((task) => task.actionSlug === "dev/preview-freeze");
    expect(freeze?.args).toMatchObject({ services: ["workflow-builder"] });
    expect(result.returnValue).toMatchObject({
      freezeOutcome: {
        attempted: true,
        frozen: true,
        receipt: { ok: true, frozen: true },
      },
      pullRequestReceipt: { receiptId: promotionReceipt.receiptId, draft: true },
    });
  });

  it("records the freeze failure without failing the promoted run", async () => {
    const { result, tasks } = await drive(
      { retainAfterCompletion: true },
      { freezeResult: { success: false, error: "sidecar unreachable" } },
    );
    expect(result.status, result.error?.message).toBe("done");
    expect(
      tasks.some((task) => task.actionSlug === "dev/preview-freeze"),
    ).toBe(true);
    expect(result.returnValue).toMatchObject({
      controlOutcome: "submitted",
      freezeOutcome: {
        attempted: true,
        frozen: false,
        error: "sidecar unreachable",
      },
      pullRequestReceipt: { receiptId: promotionReceipt.receiptId, draft: true },
    });
  });

  it("skips freeze and spawns a persistent session on interactive handoff", async () => {
    const { result, tasks } = await drive({
      retainAfterCompletion: true,
      ttlHours: 8,
      interactiveHandoff: true,
    });
    expect(result.status, result.error?.message).toBe("done");
    expect(actionSlugs(tasks)).toEqual([
      "dev/preview",
      "dev/preview-snapshot",
      "dev/preview-promote",
      "session/spawn",
    ]);
    const spawn = tasks.find((task) => task.actionSlug === "session/spawn");
    expect(spawn?.args).toMatchObject({
      agentSlug: "glm-juicefs-builder-agent",
    });
    expect(result.returnValue).toMatchObject({
      handoff: true,
      interactiveHandoff: true,
      sessionId: "sess-1",
      sessionUrl: "https://session.example.test/sess-1",
      sandboxTimeoutSeconds: 28800,
      freezeOutcome: {
        attempted: false,
        frozen: false,
        skipped: "interactive-handoff",
      },
    });
  });

  it("hands off without retention using today's sandbox lifetime", async () => {
    const { result, tasks } = await drive({ interactiveHandoff: true });
    expect(result.status, result.error?.message).toBe("done");
    expect(previewTask(tasks)?.args).toMatchObject({ timeoutSeconds: 86400 });
    expect(
      tasks.some((task) => task.actionSlug === "dev/preview-freeze"),
    ).toBe(false);
    const output = result.returnValue as Record<string, unknown>;
    expect(output).toMatchObject({
      handoff: true,
      sessionId: "sess-1",
      sessionUrl: "https://session.example.test/sess-1",
    });
    expect(output).not.toHaveProperty("retainAfterCompletion");
    expect(output).not.toHaveProperty("sandboxTimeoutSeconds");
  });
});

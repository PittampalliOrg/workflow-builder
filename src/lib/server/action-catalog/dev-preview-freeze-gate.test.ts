import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/dapr-client", () => ({
  daprFetch: vi.fn(async () => new Response("offline", { status: 503 })),
  getFnSystemUrl: () => "http://fn-system",
  getOrchestratorUrl: () => "http://workflow-orchestrator",
}));

// The catalog module caches assembled actions per-process, so each test
// resets the module registry and re-imports to observe the flag it stubbed.
async function loadSnapshotFresh() {
  vi.resetModules();
  const { loadActionCatalogSnapshot } = await import("./index");
  return loadActionCatalogSnapshot(null);
}

describe("dev/preview-freeze catalog gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("omits dev/preview-freeze by default so the action is never visible before the function-router dispatch is wired", async () => {
    const snapshot = await loadSnapshotFresh();
    expect(
      snapshot.items.find((item) => item.actionName === "dev/preview-freeze"),
    ).toBeUndefined();
  });

  it("treats non-true flag values as disabled", async () => {
    vi.stubEnv("DEV_PREVIEW_FREEZE_ACTION_ENABLED", "1");
    const snapshot = await loadSnapshotFresh();
    expect(
      snapshot.items.find((item) => item.actionName === "dev/preview-freeze"),
    ).toBeUndefined();
  });

  it("exposes the insertable action when DEV_PREVIEW_FREEZE_ACTION_ENABLED=true", async () => {
    vi.stubEnv("DEV_PREVIEW_FREEZE_ACTION_ENABLED", "true");
    const snapshot = await loadSnapshotFresh();
    const action = snapshot.items.find(
      (item) => item.actionName === "dev/preview-freeze",
    );
    expect(action).toMatchObject({
      id: "builtin.dev/preview-freeze",
      actionName: "dev/preview-freeze",
      service: "function-router",
      insertable: true,
    });
  });
});

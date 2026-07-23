import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/dapr-client", () => ({
  daprFetch: vi.fn(async () => new Response("offline", { status: 503 })),
  getFnSystemUrl: () => "http://fn-system",
  getOrchestratorUrl: () => "http://workflow-orchestrator",
}));

async function loadFresh() {
  vi.resetModules();
  const catalog = await import("./index");
  return {
    catalog,
    snapshot: await catalog.loadActionCatalogSnapshot(null),
  };
}

describe("secure preview workspace action catalog gate", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the coordinated actions hidden by default", async () => {
    const { snapshot } = await loadFresh();
    expect(
      snapshot.items.filter(
        (item) =>
          typeof item.actionName === "string" &&
          [
            "dev/preview-workspace-seed",
            "dev/preview-workspace-sync",
            "dev/preview-sidecar-run",
          ].includes(item.actionName),
      ),
    ).toHaveLength(0);
  });

  it("exposes exact caller-narrow schemas after the rollout gate is enabled", async () => {
    vi.stubEnv("PREVIEW_WORKSPACE_ACTIONS_ENABLED", "true");
    const { catalog, snapshot } = await loadFresh();
    const slugs = [
      "dev/preview-workspace-seed",
      "dev/preview-workspace-sync",
      "dev/preview-sidecar-run",
    ];
    expect(
      snapshot.items
        .filter(
          (item) =>
            typeof item.actionName === "string" &&
            slugs.includes(item.actionName),
        )
        .map((item) => item.actionName)
        .sort(),
    ).toEqual([...slugs].sort());

    const sync = await catalog.getActionCatalogDetail(
      "builtin.dev/preview-workspace-sync",
      "admin-1",
    );
    expect(sync?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["service"],
      properties: { service: { type: "string" } },
    });
    expect(JSON.stringify(sync?.inputSchema)).not.toMatch(
      /executionId|workspace|repository|revision|path|url|token/i,
    );
  });
});

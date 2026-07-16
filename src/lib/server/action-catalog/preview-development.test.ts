import { describe, expect, it, vi } from "vitest";
import { loadActionCatalogSnapshot } from "./index";

vi.mock("$lib/server/dapr-client", () => ({
  daprFetch: vi.fn(async () => new Response("offline", { status: 503 })),
  getFnSystemUrl: () => "http://fn-system",
  getOrchestratorUrl: () => "http://workflow-orchestrator",
}));

const slugs = [
  "preview/environment-launch",
  "preview/environment-status",
  "preview/workflow-start",
  "preview/workflow-status",
  "preview/workflow-signal",
  "preview/workflow-verify-promotion",
  "preview/environment-teardown",
  "preview/environment-teardown-status",
];

describe("preview development action catalog", () => {
  it("exposes the complete host lifecycle action set", async () => {
    const snapshot = await loadActionCatalogSnapshot(null);
    const actions = snapshot.items.filter(
      (item) => item.providerId === "preview-development",
    );
    expect(actions.map((item) => item.actionName).sort()).toEqual(
      [...slugs].sort(),
    );
    expect(actions).toEqual(
      expect.arrayContaining(
        slugs.map((slug) =>
          expect.objectContaining({
            id: `builtin.${slug}`,
            actionName: slug,
            service: "function-router",
            insertable: true,
          }),
        ),
      ),
    );
  });

  it("does not expose actor, origin, revision authority, URL, or credentials on launch", async () => {
    const snapshot = await loadActionCatalogSnapshot(null);
    const launch = snapshot.items.find(
      (item) => item.actionName === "preview/environment-launch",
    );
    const schema = JSON.stringify(launch?.inputSchema ?? {});
    expect(schema).toContain("environmentName");
    expect(schema).toContain("services");
    expect(schema).not.toContain("userId");
    expect(schema).not.toContain("origin");
    expect(schema).not.toContain("Revision");
    expect(schema).not.toContain("Url");
    expect(schema).not.toContain("credential");
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PREVIEW_CONTROL_BROKER_ROUTES,
  previewControlBrokerModeResponse,
} from "./hooks.server";

describe("server hooks boundary", () => {
  it("resolves request project scope through application services", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "hooks.server.ts"),
      "utf8",
    );

    expect(source).toContain("getApplicationAdapters");
    expect(source).toContain("authSession.getSession");
    expect(source).toContain("workflowData.resolveSessionProjectId");
    expect(source).toContain("resolveWorkspaceProjectId");
    expect(source).not.toMatch(/from ["']\$lib\/server\/auth["']/);
    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toContain("$lib/server/db/schema");
    expect(source).not.toContain("drizzle-orm");
  });
});

describe("preview-control broker edge", () => {
  it("exposes only health and preview-control routes in broker mode", async () => {
    const health = previewControlBrokerModeResponse("/healthz", "GET", true);
    expect(health?.status).toBe(200);
    await expect(health?.json()).resolves.toEqual({ ok: true });
    for (const [method, path] of PREVIEW_CONTROL_BROKER_ROUTES) {
      expect(previewControlBrokerModeResponse(path, method, true)).toBeNull();
      expect(
        previewControlBrokerModeResponse(
          path,
          method === "POST" ? "GET" : "POST",
          true,
        )?.status,
      ).toBe(404);
    }
    expect(PREVIEW_CONTROL_BROKER_ROUTES).toContainEqual([
      "POST",
      "/api/internal/preview-control/artifacts",
    ]);
    expect(PREVIEW_CONTROL_BROKER_ROUTES).toContainEqual([
      "POST",
      "/api/internal/preview-control/promotion",
    ]);
    expect(PREVIEW_CONTROL_BROKER_ROUTES).toContainEqual([
      "POST",
      "/api/internal/preview-control/environment",
    ]);
    expect(PREVIEW_CONTROL_BROKER_ROUTES).toContainEqual([
      "POST",
      "/api/internal/preview-control/environment/observe",
    ]);
    expect(
      previewControlBrokerModeResponse(
        "/api/internal/preview-control/environment/observe",
        "GET",
        true,
      )?.status,
    ).toBe(404);
    for (const route of [
      "/api/internal/preview-control/dev-sync-credentials",
      "/api/internal/preview-control/accepted-images/reuse",
      "/api/internal/preview-control/activation-images",
    ]) {
      expect(PREVIEW_CONTROL_BROKER_ROUTES).toContainEqual(["POST", route]);
    }
    expect(PREVIEW_CONTROL_BROKER_ROUTES).toContainEqual([
      "POST",
      "/api/internal/preview-control/deletion-intents/reconcile",
    ]);
    expect(
      previewControlBrokerModeResponse(
        "/api/internal/preview-control/environment/feature-one/teardown",
        "POST",
        true,
      ),
    ).toBeNull();
    expect(
      previewControlBrokerModeResponse(
        "/api/internal/preview-control/environment/feature-one/cleanup",
        "GET",
        true,
      ),
    ).toBeNull();
    expect(
      previewControlBrokerModeResponse(
        "/api/internal/preview-control/environment/feature-one/headlamp",
        "POST",
        true,
      ),
    ).toBeNull();
    for (const [path, method] of [
      [
        "/api/internal/preview-control/environment/feature-one/headlamp",
        "GET",
      ],
      [
        "/api/internal/preview-control/environment/Feature-one/headlamp",
        "POST",
      ],
      [
        "/api/internal/preview-control/environment/feature-one/headlamp/extra",
        "POST",
      ],
    ] as const) {
      expect(previewControlBrokerModeResponse(path, method, true)?.status).toBe(
        404,
      );
    }
    expect(PREVIEW_CONTROL_BROKER_ROUTES).not.toContainEqual([
      "POST",
      "/api/internal/preview-control/pr-adoption",
    ]);
    for (const path of [
      "/",
      "/workspaces/default/dev",
      "/api/workflows/executions/exec-1",
      "/api/internal/workflows/executions/exec-1/dev-preview/build",
      "/api/v1/auth/sign-in",
      "/api/internal/preview-control/future-route",
    ]) {
      expect(previewControlBrokerModeResponse(path, "GET", true)?.status).toBe(
        404,
      );
    }
  });

  it("does not affect the normal application mode", () => {
    expect(
      previewControlBrokerModeResponse("/workspaces/default", "GET", false),
    ).toBeNull();
  });
});

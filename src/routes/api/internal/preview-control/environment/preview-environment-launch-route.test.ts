import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewEnvironmentLaunchAuthorizationError } from "$lib/server/application/preview-environment-launch-broker";

const mocks = vi.hoisted(() => ({
  requirePreviewControlBroker: vi.fn(),
  launchForUser: vi.fn(async () => ({
    ok: false,
    reason: "capacity",
    awake: 4,
    max: 4,
    message: "full",
  })),
}));

vi.mock("$lib/server/internal-auth", () => ({
  requirePreviewControlBroker: mocks.requirePreviewControlBroker,
}));
vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewEnvironmentLaunchBroker: {
      launchForUser: mocks.launchForUser,
    },
  }),
}));

import { POST } from "./+server";

function event(extra: Record<string, unknown> = {}) {
  return {
    request: new Request(
      "http://broker/api/internal/preview-control/environment",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "feature-one",
          userId: "admin-1",
          profile: "app-live",
          services: ["workflow-builder"],
          allocation: { kind: "cold" },
          ...extra,
        }),
      },
    ),
  };
}

describe("physical preview environment launch route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PREVIEW_CONTROL_BROKER_MODE", "true");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires the normal-BFF broker credential and replays the narrow intent", async () => {
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(200);
    expect(mocks.requirePreviewControlBroker).toHaveBeenCalledOnce();
    expect(mocks.launchForUser).toHaveBeenCalledWith({
      name: "feature-one",
      userId: "admin-1",
      profile: "app-live",
      services: ["workflow-builder"],
      allocation: { kind: "cold" },
    });
  });

  it("rejects caller capability bundles and physical credentials", async () => {
    const response = (await POST(
      event({
        capabilityBundle: { controlToken: "attacker" },
        kubeconfig: "attacker",
      }) as never,
    )) as Response;
    expect(response.status).toBe(400);
    expect(mocks.launchForUser).not.toHaveBeenCalled();
  });

  it("maps the physical admin recheck to 403", async () => {
    mocks.launchForUser.mockRejectedValueOnce(
      new PreviewEnvironmentLaunchAuthorizationError("admin required"),
    );
    const response = (await POST(event() as never)) as Response;
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "admin required",
    });
  });
});

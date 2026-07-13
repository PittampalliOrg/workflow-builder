import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PreviewEnvironmentUnavailableError,
  PreviewEnvironmentValidationError,
} from "$lib/server/application/preview-environments";

const mocks = vi.hoisted(() => ({
  launchForUser: vi.fn(async () => ({ ok: true, environment: {} })),
  launchInfrastructure: vi.fn(async () => ({
    ok: true,
    status: "launched",
    profile: "manifest-candidate",
    pullRequest: {},
    changedPaths: [],
    launch: { ok: true, environment: {} },
  })),
  presentLaunch: vi.fn(() => ({
    ok: true,
    pooled: false,
    preview: { name: "feature-x", phase: "provisioning" },
  })),
  list: vi.fn(async () => ({ previews: [], counts: null })),
  isControlPlane: vi.fn(() => true),
  requirePlatformAdmin: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewDeploymentScope: { isControlPlane: mocks.isControlPlane },
    previewEnvironments: { launchForUser: mocks.launchForUser },
    previewInfrastructureCandidates: { launch: mocks.launchInfrastructure },
    vclusterPreviews: {
      presentLaunch: mocks.presentLaunch,
      list: mocks.list,
    },
  }),
}));

vi.mock("$lib/server/platform-admin", () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
}));

import { POST } from "./+server";

function request(body: unknown, userId = "session-user") {
  return {
    locals: { session: { userId } },
    request: new Request("http://localhost/api/dev-environments/vcluster", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

async function expectStatus(
  promise: Promise<unknown> | unknown,
  status: number,
) {
  try {
    const value = await Promise.resolve(promise);
    expect((value as Response).status).toBe(status);
  } catch (cause) {
    expect((cause as { status?: number }).status).toBe(status);
  }
}

describe("vcluster PreviewEnvironment launch route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePlatformAdmin.mockResolvedValue(undefined);
    mocks.launchForUser.mockResolvedValue({ ok: true, environment: {} });
    mocks.launchInfrastructure.mockResolvedValue({
      ok: true,
      status: "launched",
      profile: "manifest-candidate",
      pullRequest: {},
      changedPaths: [],
      launch: { ok: true, environment: {} },
    });
    mocks.presentLaunch.mockReturnValue({
      ok: true,
      pooled: false,
      preview: { name: "feature-x", phase: "provisioning" },
    });
  });

  it("stays authenticated and routes through the application boundary", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
      "utf8",
    );
    expect(source).toContain("previewEnvironments.launchForUser");
    expect(source).not.toContain("$lib/server/application/adapters");
    expect(source).not.toContain("trustedCode:");
    expect(source).not.toContain("owner:");
  });

  it("sends only a PR number and server-derived identity to the physical broker", async () => {
    const response = (await POST(
      request({
        name: "Feature X",
        profile: "manifest-candidate",
        capabilities: ["namespaced-manifests"],
        pullRequest: { number: 42 },
        candidatePaths: ["caller/forgery.yaml"],
        ttlHours: 12,
        lifecycle: "ephemeral",
        allocation: { kind: "cold" },
        provenance: {
          parentEnvironmentId: "parent-1",
          requestId: "client-forgery",
        },
        owner: { kind: "automation", id: "attacker" },
        trustedCode: false,
      }) as never,
    )) as Response;

    expect(response.status).toBe(202);
    expect(mocks.requirePlatformAdmin).toHaveBeenCalledOnce();
    expect(mocks.launchInfrastructure).toHaveBeenCalledWith({
      requestId: expect.any(String),
      name: "feature-x",
      userId: "session-user",
      pullRequestNumber: 42,
      ttlHours: 12,
      lifecycle: "ephemeral",
    });
    expect(mocks.launchForUser).not.toHaveBeenCalled();
  });

  it("preserves legacy name-only launches", async () => {
    await POST(request({ name: "Feature X" }) as never);
    expect(mocks.launchForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "feature-x",
        userId: "session-user",
        profile: undefined,
      }),
    );
  });

  it("rejects caller-authored candidate paths without a verified stacks PR", async () => {
    await expectStatus(
      POST(
        request({
          name: "infra",
          profile: "manifest-candidate",
          candidatePaths: ["packages/overlays/dev/kustomization.yaml"],
        }) as never,
      ),
      400,
    );
    expect(mocks.launchInfrastructure).not.toHaveBeenCalled();
    expect(mocks.launchForUser).not.toHaveBeenCalled();
  });

  it("maps validation and unavailable physical-lane failures", async () => {
    mocks.launchForUser.mockRejectedValueOnce(
      new PreviewEnvironmentValidationError([
        { path: "profile", code: "invalid-value", message: "bad profile" },
      ]),
    );
    await expectStatus(POST(request({ name: "x" }) as never), 400);

    mocks.launchForUser.mockRejectedValueOnce(
      new PreviewEnvironmentUnavailableError("physical lane unavailable"),
    );
    await expectStatus(POST(request({ name: "x" }) as never), 501);
  });

  it("rejects unauthenticated calls before launch", async () => {
    await expectStatus(
      POST({ ...request({ name: "x" }), locals: {} } as never),
      401,
    );
    expect(mocks.launchForUser).not.toHaveBeenCalled();
    expect(mocks.requirePlatformAdmin).not.toHaveBeenCalled();
  });

  it("rejects launch from a preview deployment even for an admin", async () => {
    mocks.isControlPlane.mockReturnValueOnce(false);

    await expectStatus(POST(request({ name: "feature-x" }) as never), 403);

    expect(mocks.requirePlatformAdmin).not.toHaveBeenCalled();
    expect(mocks.launchForUser).not.toHaveBeenCalled();
  });

  it("rejects non-admin callers before revision resolution or launch", async () => {
    mocks.requirePlatformAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Admin access required"), { status: 403 }),
    );
    await expectStatus(POST(request({ name: "x" }) as never), 403);
    expect(mocks.launchForUser).not.toHaveBeenCalled();
  });
});

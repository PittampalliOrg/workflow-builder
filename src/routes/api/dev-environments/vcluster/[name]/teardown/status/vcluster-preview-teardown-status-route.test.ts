import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PreviewEnvironmentDesiredStateError,
  PreviewEnvironmentDesiredStateOwnershipError,
} from "$lib/server/application/ports";

const ticket = {
  name: "preview-one",
  environmentUid: "uid-1",
  requestId: "request-1",
  sourceRevision: "b".repeat(40),
  signature: "e".repeat(64),
};

const pending = {
  name: "preview-one",
  resourceName: "preview-one",
  complete: false,
  phase: "pending" as const,
  checks: {
    runnerSucceeded: true,
    previewEnvironmentAbsent: false,
    applicationAbsent: false,
    agentRegistrationAbsent: false,
    agentNamespacesAbsent: false,
    databaseAbsent: true,
    natsStreamAbsent: true,
    headlampRegistrationAbsent: false,
    tailnetEgressAbsent: true,
    hostNamespaceAbsent: true,
    storageScopeAbsent: true,
    runnerIdentityAbsent: true,
  },
  message: null,
};

const mocks = vi.hoisted(() => ({
  teardownStatus: vi.fn(),
  isControlPlane: vi.fn(() => true),
  requirePlatformAdmin: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewDeploymentScope: { isControlPlane: mocks.isControlPlane },
    vclusterPreviews: { teardownStatus: mocks.teardownStatus },
  }),
}));

vi.mock("$lib/server/platform-admin", () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
}));

import { GET } from "./+server";

function event(userId: string | null = "admin-user", withTicket = true) {
  const url = new URL("http://localhost/api/dev-environments/vcluster/preview-one/teardown/status");
  if (withTicket) {
    for (const [key, value] of Object.entries(ticket)) {
      if (key !== "name") url.searchParams.set(key, value);
    }
  }
  return {
    params: { name: "preview-one" },
    locals: userId ? { session: { userId } } : {},
    url,
  };
}

async function responseStatus(value: unknown): Promise<number> {
  try {
    return ((await value) as Response).status;
  } catch (cause) {
    return (cause as { status?: number }).status ?? 500;
  }
}

describe("vcluster preview teardown status route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isControlPlane.mockReturnValue(true);
    mocks.teardownStatus.mockResolvedValue(pending);
  });

  it("returns retryable 202 progress through the application boundary", async () => {
    const response = (await GET(event() as never)) as Response;

    expect(response.status).toBe(202);
    expect(response.headers.get("retry-after")).toBe("5");
    await expect(response.json()).resolves.toEqual({ teardown: pending, ticket });
    expect(mocks.requirePlatformAdmin).toHaveBeenCalledOnce();
    expect(mocks.teardownStatus).toHaveBeenCalledWith(ticket);
  });

  it("returns 200 only after physical cleanup is complete", async () => {
    mocks.teardownStatus.mockResolvedValueOnce({
      ...pending,
      complete: true,
      phase: "complete",
      checks: Object.fromEntries(
        Object.keys(pending.checks).map((key) => [key, true]),
      ),
    });

    const response = (await GET(event() as never)) as Response;

    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it("requires authentication, control-plane scope, and platform admin", async () => {
    expect(await responseStatus(GET(event(null) as never))).toBe(401);
    mocks.isControlPlane.mockReturnValueOnce(false);
    expect(await responseStatus(GET(event() as never))).toBe(403);
    expect(mocks.teardownStatus).not.toHaveBeenCalled();
  });

  it("rejects a missing ticket before observation", async () => {
    expect(await responseStatus(GET(event("admin-user", false) as never))).toBe(400);
    expect(mocks.teardownStatus).not.toHaveBeenCalled();
  });

  it("maps desired-state observation failures to a retryable service error", async () => {
    mocks.teardownStatus.mockRejectedValueOnce(
      new PreviewEnvironmentDesiredStateError("broker unavailable"),
    );

    expect(await responseStatus(GET(event() as never))).toBe(503);
  });

  it("maps a generation mismatch to conflict", async () => {
    mocks.teardownStatus.mockRejectedValueOnce(
      new PreviewEnvironmentDesiredStateOwnershipError("generation changed"),
    );

    expect(await responseStatus(GET(event() as never))).toBe(409);
  });

  it("does not import Kubernetes or infrastructure adapters", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
      "utf8",
    );
    expect(source).toContain("vclusterPreviews.teardownStatus");
    expect(source).not.toContain("$lib/server/application/adapters");
    expect(source).not.toContain("$lib/server/workflows/vcluster-preview");
    expect(source).not.toContain("@kubernetes/client-node");
  });
});

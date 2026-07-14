import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isControlPlane: vi.fn(() => true),
  teardown: vi.fn(async () => ({
    archive: null,
    preview: { name: "preview-one", phase: "terminating" },
    ticket: {
      name: "preview-one",
      environmentUid: "uid-1",
      requestId: "request-1",
      sourceRevision: "b".repeat(40),
      signature: "e".repeat(64),
    },
  })),
  present: vi.fn((preview: unknown) => preview),
  requirePlatformAdmin: vi.fn(async () => undefined),
}));

vi.mock("$lib/server/application", () => ({
  getApplicationAdapters: () => ({
    previewDeploymentScope: { isControlPlane: mocks.isControlPlane },
    previewTeardown: { teardown: mocks.teardown },
    vclusterPreviews: { present: mocks.present },
  }),
}));

vi.mock("$lib/server/platform-admin", () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
}));

import { DELETE } from "./+server";
import {
  PreviewEnvironmentDesiredStateError,
  PreviewEnvironmentDesiredStateOwnershipError,
} from "$lib/server/application/ports";

function request(query = "", userId = "owner-1", includeIdentity = true) {
  const url = new URL(
    `http://localhost/api/dev-environments/vcluster/preview-one${query}`,
  );
  if (includeIdentity) {
    if (!url.searchParams.has("expectedRequestId")) {
      url.searchParams.set("expectedRequestId", "request-1");
    }
    if (!url.searchParams.has("expectedSourceRevision")) {
      url.searchParams.set("expectedSourceRevision", "b".repeat(40));
    }
  }
  return {
    params: { name: "preview-one" },
    locals: { session: { userId, projectId: "project-1" } },
    url,
  };
}

describe("vcluster preview teardown route (E3 archive-on-teardown)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isControlPlane.mockReturnValue(true);
    mocks.requirePlatformAdmin.mockResolvedValue(undefined);
    mocks.teardown.mockResolvedValue({
      archive: null,
      preview: { name: "preview-one", phase: "terminating" },
      ticket: {
        name: "preview-one",
        environmentUid: "uid-1",
        requestId: "request-1",
        sourceRevision: "b".repeat(40),
        signature: "e".repeat(64),
      },
    });
  });

  it("delegates teardown policy to the hexagonal application service", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
      "utf8",
    );
    expect(source).toContain("previewTeardown.teardown");
    expect(source).not.toContain("previewArchive.archivePreview");
    expect(source).not.toContain("vclusterPreviews.teardown");
    expect(source).not.toContain("previewArchiveOnTeardownEnabled");
  });

  it("requires platform-admin authority and preserves the selected generation", async () => {
    const response = (await DELETE(
      request("?discardUnarchived=true") as never,
    )) as Response;

    expect(response.status).toBe(202);
    await expect(response.clone().json()).resolves.toMatchObject({
      teardown: { environmentUid: "uid-1", signature: "e".repeat(64) },
    });
    expect(mocks.requirePlatformAdmin).toHaveBeenCalledOnce();
    expect(mocks.teardown).toHaveBeenCalledWith({
      name: "preview-one",
      actorUserId: "owner-1",
      expectedRequestId: "request-1",
      expectedSourceRevision: "b".repeat(40),
      projectId: "project-1",
      discardUnarchived: true,
    });
  });

  it.each(["", "?discardUnarchived=TRUE", "?discardUnarchived=1", "?discardUnarchived="])(
    "does not enable discard for a missing or non-exact value (%s)",
    async (query) => {
      await DELETE(request(query) as never);

      expect(mocks.requirePlatformAdmin).toHaveBeenCalledOnce();
      expect(mocks.teardown).toHaveBeenCalledWith({
        name: "preview-one",
        actorUserId: "owner-1",
        expectedRequestId: "request-1",
        expectedSourceRevision: "b".repeat(40),
        projectId: "project-1",
      });
    },
  );

  it("denies a non-admin discard before application teardown", async () => {
    mocks.requirePlatformAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Admin access required"), { status: 403 }),
    );

    await expect(
      DELETE(request("?discardUnarchived=true", "member-1") as never),
    ).rejects.toMatchObject({ status: 403 });
    expect(mocks.teardown).not.toHaveBeenCalled();
  });

  it("rejects a missing selected generation before application teardown", async () => {
    await expect(DELETE(request("", "owner-1", false) as never)).rejects.toMatchObject({
      status: 400,
    });
    expect(mocks.teardown).not.toHaveBeenCalled();
  });

  it("returns completed only when cleanup already converged", async () => {
    mocks.teardown.mockResolvedValueOnce({
      archive: null,
      preview: { name: "preview-one", phase: "absent" },
      ticket: null,
    } as never);

    const response = (await DELETE(request() as never)) as Response;

    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  it.each([
    [PreviewEnvironmentDesiredStateOwnershipError, 409],
    [PreviewEnvironmentDesiredStateError, 503],
  ])("maps desired-state failures through the public route", async (ErrorType, status) => {
    mocks.teardown.mockRejectedValueOnce(new ErrorType("teardown failure"));

    await expect(DELETE(request() as never)).rejects.toMatchObject({ status });
  });

  it("keeps forceFailed exact and subordinate to admin discard", async () => {
    await DELETE(request("?forceFailed=true") as never);
    expect(mocks.teardown).toHaveBeenLastCalledWith(
      expect.objectContaining({ forceFailed: true }),
    );
    expect(mocks.requirePlatformAdmin).toHaveBeenCalledOnce();

    await DELETE(
      request("?forceFailed=true&discardUnarchived=true") as never,
    );
    expect(mocks.requirePlatformAdmin).toHaveBeenCalledTimes(2);
    expect(mocks.teardown).toHaveBeenLastCalledWith(
      expect.objectContaining({ discardUnarchived: true }),
    );
    expect(mocks.teardown).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ forceFailed: true }),
    );
  });

  it("stays session-gated and adapter-free", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
      "utf8",
    );
    expect(source).toContain("locals.session?.userId");
    expect(source).toContain("previewAccess.authorize");
    expect(source).not.toContain("$lib/server/application/adapters");
    expect(source).not.toContain("$lib/server/db");
    expect(source).not.toContain("drizzle-orm");
  });
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isControlPlane: vi.fn(() => true),
  teardown: vi.fn(async () => ({
    archive: null,
    preview: { name: "preview-one", phase: "terminating" },
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

function request(query = "", userId = "owner-1") {
  return {
    params: { name: "preview-one" },
    locals: { session: { userId, projectId: "project-1" } },
    url: new URL(
      `http://localhost/api/dev-environments/vcluster/preview-one${query}`,
    ),
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

  it("requires platform-admin authority for the exact discard query value", async () => {
    const response = (await DELETE(
      request("?discardUnarchived=true") as never,
    )) as Response;

    expect(response.status).toBe(200);
    expect(mocks.requirePlatformAdmin).toHaveBeenCalledOnce();
    expect(mocks.teardown).toHaveBeenCalledWith({
      name: "preview-one",
      actorUserId: "owner-1",
      projectId: "project-1",
      discardUnarchived: true,
    });
  });

  it.each(["", "?discardUnarchived=TRUE", "?discardUnarchived=1", "?discardUnarchived="])(
    "does not enable discard for a missing or non-exact value (%s)",
    async (query) => {
      await DELETE(request(query) as never);

      expect(mocks.requirePlatformAdmin).not.toHaveBeenCalled();
      expect(mocks.teardown).toHaveBeenCalledWith({
        name: "preview-one",
        actorUserId: "owner-1",
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

  it("keeps forceFailed exact and subordinate to admin discard", async () => {
    await DELETE(request("?forceFailed=true") as never);
    expect(mocks.teardown).toHaveBeenLastCalledWith(
      expect.objectContaining({ forceFailed: true }),
    );
    expect(mocks.requirePlatformAdmin).not.toHaveBeenCalled();

    await DELETE(
      request("?forceFailed=true&discardUnarchived=true") as never,
    );
    expect(mocks.requirePlatformAdmin).toHaveBeenCalledOnce();
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

import { describe, expect, it, vi } from "vitest";
import { ApplicationPreviewAccessService } from "$lib/server/application/preview-access";

function harness(ownerId = "owner-1") {
  const previews = {
    get: vi.fn(
      async () =>
        ({
          name: "feature-one",
          phase: "ready",
          owner: { kind: "user" as const, id: ownerId },
        }) as never,
    ),
  };
  const admins = { isPlatformAdmin: vi.fn(async () => false) };
  const scope = { allowsPreviewName: vi.fn(() => true) };
  return {
    previews,
    admins,
    scope,
    service: new ApplicationPreviewAccessService({ previews, admins, scope }),
  };
}

describe("preview owner/admin access policy", () => {
  it("admits the authoritative owner without broad admin lookup", async () => {
    const h = harness();
    await expect(
      h.service.authorize({ name: "feature-one", actorUserId: "owner-1" }),
    ).resolves.toMatchObject({ actorIsOwner: true, ownerId: "owner-1" });
    expect(h.admins.isPlatformAdmin).not.toHaveBeenCalled();
  });

  it("admits a different actor only through central platform-admin policy", async () => {
    const h = harness();
    h.admins.isPlatformAdmin.mockResolvedValueOnce(true);
    await expect(
      h.service.authorize({ name: "feature-one", actorUserId: "admin-2" }),
    ).resolves.toMatchObject({
      actorIsOwner: false,
      actorIsPlatformAdmin: true,
    });
    expect(h.admins.isPlatformAdmin).toHaveBeenCalledWith("admin-2");
  });

  it("denies a second non-admin user and ownerless legacy state", async () => {
    const h = harness();
    await expect(
      h.service.authorize({ name: "feature-one", actorUserId: "user-2" }),
    ).rejects.toThrow("preview access denied");
    const ownerless = harness("");
    await expect(
      ownerless.service.authorize({
        name: "feature-one",
        actorUserId: "user-2",
      }),
    ).rejects.toThrow("authoritative owner");
  });

  it("rejects cross-preview access before reading physical state", async () => {
    const h = harness();
    h.scope.allowsPreviewName.mockReturnValueOnce(false);

    await expect(
      h.service.authorize({ name: "feature-two", actorUserId: "owner-1" }),
    ).rejects.toThrow("cross-preview access");
    expect(h.previews.get).not.toHaveBeenCalled();
  });
});

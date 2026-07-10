import type {
  PreviewAccessPolicyPort,
  PreviewControlAdminAuthorizationPort,
  VclusterPreviewGatewayPort,
} from "$lib/server/application/ports";

export class PreviewAccessDeniedError extends Error {
  constructor(message = "preview access denied") {
    super(message);
    this.name = "PreviewAccessDeniedError";
  }
}

type PreviewAccessDeps = Readonly<{
  previews: Pick<VclusterPreviewGatewayPort, "get">;
  admins: PreviewControlAdminAuthorizationPort;
}>;

/** Owner-or-platform-admin policy shared by every preview read and mutation. */
export class ApplicationPreviewAccessService implements PreviewAccessPolicyPort {
  constructor(private readonly deps: PreviewAccessDeps) {}

  async authorize(input: { name: string; actorUserId: string }) {
    const actorUserId = input.actorUserId.trim();
    if (!actorUserId) throw new PreviewAccessDeniedError();
    const preview = await this.deps.previews.get(input.name);
    const ownerId = preview.owner?.id?.trim() ?? "";
    if (!ownerId || preview.phase === "absent") {
      throw new PreviewAccessDeniedError("preview has no authoritative owner");
    }
    const actorIsOwner = ownerId === actorUserId;
    const actorIsPlatformAdmin = actorIsOwner
      ? false
      : await this.deps.admins.isPlatformAdmin(actorUserId);
    if (!actorIsOwner && !actorIsPlatformAdmin) {
      throw new PreviewAccessDeniedError();
    }
    return Object.freeze({
      preview,
      ownerId,
      actorIsOwner,
      actorIsPlatformAdmin,
    });
  }
}

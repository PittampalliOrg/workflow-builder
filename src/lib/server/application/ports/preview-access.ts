import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

export type AuthorizedPreviewAccess = Readonly<{
  preview: VclusterPreviewRecord;
  ownerId: string;
  actorIsOwner: boolean;
  actorIsPlatformAdmin: boolean;
}>;

export interface PreviewAccessPolicyPort {
  authorize(
    input: Readonly<{
      name: string;
      actorUserId: string;
    }>,
  ): Promise<AuthorizedPreviewAccess>;
}

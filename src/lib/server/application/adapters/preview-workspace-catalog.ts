import type {
  PreviewWorkspaceCatalogPort,
  PreviewWorkspaceSourcePlan,
} from "$lib/server/application/ports";
import {
  devPreviewCommands,
  devPreviewCaptureOnly,
  devPreviewSyncPaths,
  resolveDevPreviewDescriptor,
} from "$lib/server/workflows/dev-preview-registry";

/** Local registry adapter; the application service never imports legacy catalog code. */
export class LocalPreviewWorkspaceCatalogAdapter implements PreviewWorkspaceCatalogPort {
  resolve(service: string | null | undefined): PreviewWorkspaceSourcePlan {
    const descriptor = resolveDevPreviewDescriptor(service);
    return Object.freeze({
      service: descriptor.service,
      repository: descriptor.repoUrl,
      repoSubdir: descriptor.repoSubdir,
      syncPaths: Object.freeze(devPreviewSyncPaths(descriptor)),
      stageMappings: Object.freeze([
        ...(descriptor.extraSync ?? []).map((mapping) =>
          Object.freeze({ ...mapping }),
        ),
        ...devPreviewCaptureOnly(descriptor).map((mapping) =>
          Object.freeze({ ...mapping }),
        ),
      ]),
      allowedCommands: Object.freeze(
        Object.keys(devPreviewCommands(descriptor)).sort(),
      ),
    });
  }
}

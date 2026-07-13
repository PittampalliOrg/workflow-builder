import { safePreviewName } from "$lib/types/dev-previews";
import type {
  PreviewDeploymentDescriptor,
  PreviewDeploymentScope,
  PreviewDeploymentScopePort,
} from "$lib/server/application/ports";

export class PreviewDeploymentScopeDeniedError extends Error {
  constructor(message = "preview deployment scope denied this operation") {
    super(message);
    this.name = "PreviewDeploymentScopeDeniedError";
  }
}

/**
 * Application policy for the BFF deployment's authority boundary. A canonical
 * control-plane deployment may operate on the preview fleet; candidate code in
 * a preview deployment may read only its own exact preview identity.
 */
export class ApplicationPreviewDeploymentScopeService
  implements PreviewDeploymentScopePort
{
  private readonly scope: PreviewDeploymentScope;

  constructor(preview: PreviewDeploymentDescriptor | null) {
    if (!preview) {
      this.scope = Object.freeze({ kind: "control-plane" });
      return;
    }
    const rawName = preview.name.trim();
    const name = safePreviewName(rawName);
    if (rawName !== name) {
      throw new Error(
        "preview deployment identity must be a canonical preview name",
      );
    }
    this.scope = Object.freeze({
      kind: "preview",
      preview: Object.freeze({ ...preview, name }),
    });
  }

  current(): PreviewDeploymentScope {
    return this.scope;
  }

  isControlPlane(): boolean {
    return this.scope.kind === "control-plane";
  }

  /** Control plane may address any preview; a preview BFF may address only itself. */
  allowsPreviewName(inputName: string): boolean {
    if (this.scope.kind === "control-plane") return true;
    const rawName = inputName.trim();
    return (
      rawName === safePreviewName(rawName) &&
      rawName === this.scope.preview.name
    );
  }
}

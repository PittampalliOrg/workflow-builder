import type {
  PreviewControlSourceAuthorityPort,
  PreviewWorkspaceCatalogPort,
  PreviewWorkspaceGitBundlePort,
  PreviewWorkspaceSourceBundlePort,
  PreviewWorkspaceSourceBundleRequest,
} from "$lib/server/application/ports";
import { PreviewWorkspaceGatewayError } from "$lib/server/application/ports";

const SAFE_SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_SOURCE_FILES = 20_000;

type PreviewWorkspaceSourceBrokerDeps = Readonly<{
  authority: Pick<PreviewControlSourceAuthorityPort, "authorizeRuntime">;
  catalog: PreviewWorkspaceCatalogPort;
  git: PreviewWorkspaceGitBundlePort;
}>;

/** Physical broker for an exact, credential-free preview source baseline. */
export class ApplicationPreviewWorkspaceSourceBrokerService implements PreviewWorkspaceSourceBundlePort {
  constructor(private readonly deps: PreviewWorkspaceSourceBrokerDeps) {}

  async fetchExact(input: PreviewWorkspaceSourceBundleRequest) {
    if (!SAFE_SERVICE.test(input.service)) {
      throw new PreviewWorkspaceGatewayError(
        "source-rejected",
        409,
        "preview workspace source service is invalid",
      );
    }
    const authorized = await this.deps.authority.authorizeRuntime({
      ...input.identity,
      requiredServices: [input.service],
    });
    if (
      authorized.previewName !== input.identity.previewName ||
      authorized.requestId !== input.identity.environmentRequestId ||
      authorized.platformRevision !==
        input.identity.environmentPlatformRevision ||
      authorized.sourceRevision !== input.identity.environmentSourceRevision ||
      authorized.catalogDigest !== input.identity.catalogDigest ||
      authorized.services.length !== 1 ||
      authorized.services[0] !== input.service ||
      !FULL_SHA.test(authorized.sourceRevision)
    ) {
      throw new PreviewWorkspaceGatewayError(
        "source-rejected",
        409,
        "physical source authority returned a different preview identity",
      );
    }
    const source = this.deps.catalog.resolve(input.service);
    if (source.service !== input.service) {
      throw new PreviewWorkspaceGatewayError(
        "source-rejected",
        409,
        "preview workspace catalog returned a different service",
      );
    }
    const result = await this.deps.git.fetchExact({
      repository: source.repository,
      sourceRevision: authorized.sourceRevision,
    });
    if (
      result.repository !== source.repository ||
      result.sourceRevision !== authorized.sourceRevision ||
      result.bundle.byteLength < 1 ||
      !SHA256.test(result.bundleSha256) ||
      !Number.isSafeInteger(result.fileCount) ||
      result.fileCount < 1 ||
      result.fileCount > MAX_SOURCE_FILES
    ) {
      throw new PreviewWorkspaceGatewayError(
        "helper-invalid-receipt",
        502,
        "preview workspace source provider returned an invalid receipt",
      );
    }
    return result;
  }
}

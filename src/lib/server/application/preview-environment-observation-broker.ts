import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import {
  PreviewRuntimeIdentityChangedError,
  type PreviewControlIdentity,
  type PreviewControlSourceAuthorityPort,
  type PreviewEnvironmentObservationBrokerPort,
  type VclusterPreviewGatewayPort,
} from "$lib/server/application/ports";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

type PreviewEnvironmentObservationBrokerDeps = Readonly<{
  previews: Pick<VclusterPreviewGatewayPort, "get" | "runtimeForIdentity">;
  authority: Pick<
    PreviewControlSourceAuthorityPort,
    "authorizeRuntimeTuple"
  >;
}>;

function sameIdentity(
  left: PreviewControlIdentity,
  right: PreviewControlIdentity,
): boolean {
  return (
    left.previewName === right.previewName &&
    left.environmentRequestId === right.environmentRequestId &&
    left.environmentPlatformRevision === right.environmentPlatformRevision &&
    left.environmentSourceRevision === right.environmentSourceRevision &&
    left.catalogDigest === right.catalogDigest
  );
}

function recordIdentity(record: VclusterPreviewRecord): PreviewControlIdentity {
  return validatePreviewControlIdentity({
    previewName: record.name,
    environmentRequestId:
      typeof record.provenance?.requestId === "string"
        ? record.provenance.requestId
        : "",
    environmentPlatformRevision: record.platformRevision ?? "",
    environmentSourceRevision: record.sourceRevision ?? "",
    catalogDigest: (record.catalogDigest ?? "") as `sha256:${string}`,
  });
}

/**
 * Physical control-plane use case for candidate self-observation. Transport
 * authentication is owned by the driving HTTP route; this service owns the
 * immutable-generation checks and depends only on the preview gateway port.
 */
export class ApplicationPreviewEnvironmentObservationBrokerService
  implements PreviewEnvironmentObservationBrokerPort
{
  constructor(
    private readonly deps: PreviewEnvironmentObservationBrokerDeps,
  ) {}

  async inspect(
    identity: PreviewControlIdentity,
  ): Promise<VclusterPreviewRecord> {
    const expected = validatePreviewControlIdentity(identity);
    await this.deps.authority.authorizeRuntimeTuple(expected);
    const preview = await this.deps.previews.get(expected.previewName);
    let observed: PreviewControlIdentity;
    try {
      observed = recordIdentity(preview);
    } catch {
      throw new PreviewRuntimeIdentityChangedError(
        "physical preview observation returned an incomplete identity",
      );
    }
    if (!sameIdentity(expected, observed)) {
      throw new PreviewRuntimeIdentityChangedError(
        "physical preview generation changed",
      );
    }
    await this.deps.authority.authorizeRuntimeTuple(expected);
    return preview;
  }

  async observeRuntime(identity: PreviewControlIdentity) {
    const expected = validatePreviewControlIdentity(identity);
    await this.deps.authority.authorizeRuntimeTuple(expected);
    const runtime = await this.deps.previews.runtimeForIdentity(expected);
    if (
      runtime.name !== expected.previewName ||
      !sameIdentity(runtime.identity, expected)
    ) {
      throw new PreviewRuntimeIdentityChangedError(
        "physical preview runtime receipt did not match the requested generation",
      );
    }
    await this.deps.authority.authorizeRuntimeTuple(expected);
    return runtime;
  }
}

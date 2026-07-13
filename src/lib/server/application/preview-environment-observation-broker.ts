import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import {
  PreviewRuntimeIdentityChangedError,
  type PreviewControlIdentity,
  type PreviewControlEnvironmentRecord,
  type PreviewEnvironmentObservationBrokerPort,
  type PreviewEnvironmentObservationReaderPort,
  type PreviewObservedSourceAuthorityPort,
} from "$lib/server/application/ports";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";

type PreviewEnvironmentObservationBrokerDeps = Readonly<{
  observations: PreviewEnvironmentObservationReaderPort;
  authority: PreviewObservedSourceAuthorityPort;
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

function environmentRecord(
  preview: VclusterPreviewRecord,
): PreviewControlEnvironmentRecord {
  const provenance = preview.provenance;
  const parsedProvenance =
    provenance &&
    typeof provenance.requestId === "string" &&
    typeof provenance.requestedAt === "string" &&
    typeof provenance.platformRepository === "string" &&
    typeof provenance.sourceRepository === "string"
      ? {
          requestId: provenance.requestId,
          requestedAt: provenance.requestedAt,
          platformRepository: provenance.platformRepository,
          sourceRepository: provenance.sourceRepository,
          ...(typeof provenance.parentEnvironmentId === "string" ||
          provenance.parentEnvironmentId === null
            ? { parentEnvironmentId: provenance.parentEnvironmentId }
            : {}),
        }
      : null;
  return Object.freeze({
    name: preview.name,
    exists: preview.phase !== "absent",
    ready: preview.ready,
    owner: preview.owner?.id ?? null,
    profile: preview.profile,
    mode: preview.mode,
    trustedCode: preview.trustedCode === true,
    platformRevision: preview.platformRevision,
    sourceRevision: preview.sourceRevision,
    catalogDigest: preview.catalogDigest,
    services: Object.freeze([...(preview.services ?? [])]),
    provenance: parsedProvenance,
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
    const observation = await this.deps.observations.inspect(expected);
    if (!sameIdentity(observation.identity, expected)) {
      throw new PreviewRuntimeIdentityChangedError(
        "physical preview observation identity did not match the requested generation",
      );
    }
    const preview = observation.preview;
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
    await this.deps.authority.authorizeObservedRuntimeTuple(
      expected,
      environmentRecord(preview),
    );
    return preview;
  }

  async observeRuntime(identity: PreviewControlIdentity) {
    const expected = validatePreviewControlIdentity(identity);
    const observation = await this.deps.observations.observeRuntime(expected);
    const runtime = observation.runtime;
    if (
      !sameIdentity(observation.identity, expected) ||
      runtime.name !== expected.previewName ||
      !sameIdentity(runtime.identity, expected)
    ) {
      throw new PreviewRuntimeIdentityChangedError(
        "physical preview runtime receipt did not match the requested generation",
      );
    }
    let observed: PreviewControlIdentity;
    try {
      observed = recordIdentity(observation.preview);
    } catch {
      throw new PreviewRuntimeIdentityChangedError(
        "physical preview runtime receipt returned an incomplete record identity",
      );
    }
    if (!sameIdentity(observed, expected)) {
      throw new PreviewRuntimeIdentityChangedError(
        "physical preview runtime record did not match the requested generation",
      );
    }
    await this.deps.authority.authorizeObservedRuntimeTuple(
      expected,
      environmentRecord(observation.preview),
    );
    return observation;
  }
}

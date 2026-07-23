import type {
  VclusterPreviewGatewayPort,
  PreviewEnvironmentObservationReaderPort,
  PreviewEnvironmentCleanupReceiptPort,
  VclusterPreviewLaunchInput,
  VclusterPreviewSleepOutcome,
  VclusterPreviewTouchResult,
  DevPreviewSidecarPort,
  DevPreviewSidecarResult,
  DevPreviewSidecarRunOutput,
  DevPreviewSidecarStatus,
  DevPreviewSidecarSyncOutput,
} from "$lib/server/application/ports";
import { PreviewRuntimeIdentityChangedError } from "$lib/server/application/ports";
import type { PreviewDevSyncCredentialBrokerPort } from "$lib/server/application/ports";
import { HttpPreviewDevSyncCredentialBrokerAdapter } from "$lib/server/application/adapters/preview-dev-sync-credentials";
import type { VclusterPreviewRecord } from "$lib/types/dev-previews";
import { env } from "$env/dynamic/private";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { derivePreviewCapabilityBundle } from "$lib/server/preview-control-capability";
import {
  getVclusterPreviewCleanup,
  getVclusterPreviewRuntime,
  getVclusterPreview,
  getVclusterPreviewForIdentity,
  listVclusterPreviewsWithCounts,
  listVclusterPreviewCleanupReceipts,
  provisionVclusterPreview,
  sleepVclusterPreview,
  teardownVclusterPreview,
  releaseVclusterPreviewCleanupReceipt,
  touchVclusterPreview,
  VclusterPreviewHttpError,
  type VclusterPreview,
} from "$lib/server/workflows/vcluster-preview";
import {
  allowedSidecarCommands,
  fetchSidecarStatus,
  runSidecarCommand,
  syncDevPreviewSource,
} from "$lib/server/workflows/dev-preview-sidecar";

/** Legacy `VclusterPreview` → the serializable gateway record (drops the
 * job/isolation-tier plumbing the UI never reads). */
function toRecord(p: VclusterPreview): VclusterPreviewRecord {
  return {
    name: p.name,
    phase: p.phase,
    ready: p.ready,
    url: p.url,
    targetCluster: p.targetCluster,
    pool: p.pool,
    state: p.state,
    lifecycle: p.lifecycle,
    origin: p.origin,
    legacyOrigin: p.legacyOrigin,
    prNumber: p.prNumber,
    expiresAt: p.expiresAt,
    lastActive: p.lastActive,
    protected: p.protected,
    bootSeconds: p.bootSeconds,
    platformRevision: p.platformRevision,
    sourceRevision: p.sourceRevision,
    profile: p.profile,
    lane: p.lane,
    mode: p.mode,
    owner: p.owner,
    services: p.services,
    provenance: p.provenance,
    trustedCode: p.trustedCode,
    allocation: p.allocation,
    images: p.images,
    catalogDigest: p.catalogDigest,
  };
}

function capabilityBundle(name: string, input: VclusterPreviewLaunchInput) {
  const requestId = input.provenance?.requestId?.trim() ?? "";
  const identity = validatePreviewControlIdentity({
    previewName: name,
    environmentRequestId: requestId,
    environmentPlatformRevision: input.platformRevision ?? "",
    environmentSourceRevision: input.sourceRevision ?? "",
    catalogDigest: (input.catalogDigest ?? "") as `sha256:${string}`,
  });
  const root = (
    env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
    process.env.PREVIEW_CONTROL_CAPABILITY_ROOT_TOKEN ??
    ""
  ).trim();
  return derivePreviewCapabilityBundle(root, identity);
}

/** Wraps the privileged SEA vcluster-preview client. */
export class LegacyVclusterPreviewGateway
  implements VclusterPreviewGatewayPort, PreviewEnvironmentObservationReaderPort
{
  async listWithCounts() {
    const { previews, counts } = await listVclusterPreviewsWithCounts();
    return { previews: previews.map(toRecord), counts };
  }

  async get(name: string): Promise<VclusterPreviewRecord> {
    return toRecord(await getVclusterPreview(name));
  }

  async inspect(
    identity: Parameters<PreviewEnvironmentObservationReaderPort["inspect"]>[0],
  ) {
    try {
      const observed = await getVclusterPreviewForIdentity(identity);
      return {
        preview: toRecord(observed.preview),
        identity: observed.identity,
      };
    } catch (cause) {
      if (cause instanceof VclusterPreviewHttpError && cause.status === 409) {
        throw new PreviewRuntimeIdentityChangedError(cause.message);
      }
      throw cause;
    }
  }

  async provision(
    input: { name: string } & VclusterPreviewLaunchInput,
  ): Promise<VclusterPreviewRecord> {
    return toRecord(
      await provisionVclusterPreview({
        ...input,
        capabilityBundle: capabilityBundle(input.name, input),
      }),
    );
  }

  async teardown(
    name: string,
    guard: Parameters<VclusterPreviewGatewayPort["teardown"]>[1],
  ): Promise<VclusterPreviewRecord> {
    if (!guard) throw new Error("preview teardown requires an ownership guard");
    return toRecord(await teardownVclusterPreview(name, guard));
  }

  async runtime(name: string) {
    return getVclusterPreviewRuntime(name);
  }

  async runtimeForIdentity(
    identity: Parameters<VclusterPreviewGatewayPort["runtimeForIdentity"]>[0],
  ) {
    try {
      const observed = await getVclusterPreviewRuntime(
        identity.previewName,
        identity,
      );
      if (!observed.identity) {
        throw new PreviewRuntimeIdentityChangedError(
          "SEA omitted tuple-bound preview runtime identity",
        );
      }
      return { ...observed, identity: observed.identity };
    } catch (cause) {
      if (cause instanceof PreviewRuntimeIdentityChangedError) throw cause;
      if (cause instanceof VclusterPreviewHttpError && cause.status === 409) {
        throw new PreviewRuntimeIdentityChangedError(cause.message);
      }
      throw cause;
    }
  }

  async observeRuntime(
    identity: Parameters<
      PreviewEnvironmentObservationReaderPort["observeRuntime"]
    >[0],
  ) {
    const observed = await this.runtimeForIdentity(identity);
    if (!observed.preview) {
      throw new PreviewRuntimeIdentityChangedError(
        "SEA omitted the tuple-bound preview record",
      );
    }
    const { preview, ...runtime } = observed;
    return {
      preview: toRecord(preview),
      runtime,
      identity: observed.identity,
    };
  }

  async cleanup(name: string) {
    return getVclusterPreviewCleanup(name);
  }

  async touch(name: string): Promise<VclusterPreviewTouchResult> {
    return touchVclusterPreview(name);
  }

  async sleep(name: string): Promise<VclusterPreviewSleepOutcome> {
    try {
      const r = await sleepVclusterPreview(name);
      return { ok: true, name: r.name, alreadySlept: r.alreadySlept };
    } catch (err) {
      if (err instanceof VclusterPreviewHttpError) {
        return { ok: false, status: err.status, detail: err.message };
      }
      throw err;
    }
  }
}

export class LegacyPreviewEnvironmentCleanupReceiptAdapter implements PreviewEnvironmentCleanupReceiptPort {
  list() {
    return listVclusterPreviewCleanupReceipts();
  }

  release(
    receipt: Parameters<PreviewEnvironmentCleanupReceiptPort["release"]>[0],
  ) {
    return releaseVclusterPreviewCleanupReceipt(receipt);
  }
}

/** Wraps the dev-sync-sidecar pod control channel. */
export class LegacyDevPreviewSidecarGateway implements DevPreviewSidecarPort {
  constructor(
    private readonly credentialBroker: PreviewDevSyncCredentialBrokerPort = new HttpPreviewDevSyncCredentialBrokerAdapter(),
  ) {}

  status(input: {
    syncUrl: string | null | undefined;
    executionId: string;
    service: string;
  }): Promise<DevPreviewSidecarResult<DevPreviewSidecarStatus>> {
    return fetchSidecarStatus({
      ...input,
      credentialOptions: { broker: this.credentialBroker },
    });
  }

  run(input: {
    syncUrl: string | null | undefined;
    executionId: string;
    service: string;
    cmd: string;
    timeoutMs?: number;
  }): Promise<DevPreviewSidecarResult<DevPreviewSidecarRunOutput>> {
    return runSidecarCommand({
      ...input,
      credentialOptions: { broker: this.credentialBroker },
    });
  }

  sync(input: {
    syncUrl: string | null | undefined;
    executionId: string;
    service: string;
    archive: ArrayBuffer | Uint8Array;
    contentType?: string | null;
    generation?: string;
    mode?: "merge" | "replace";
  }): Promise<DevPreviewSidecarResult<DevPreviewSidecarSyncOutput>> {
    return syncDevPreviewSource({
      ...input,
      credentialOptions: { broker: this.credentialBroker },
    });
  }

  allowedCommands(service: string): string[] {
    return allowedSidecarCommands(service);
  }
}

import type {
  PreviewSleepResult,
  PreviewWakeResult,
  VclusterLaunchResult,
  VclusterPreviewCounts,
  VclusterPreviewRecord,
  VclusterPreviewRuntimeView,
  VclusterPreviewSummary,
} from "$lib/types/dev-previews";
import { safePreviewName } from "$lib/types/dev-previews";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { PreviewRuntimeIdentityChangedError } from "$lib/server/application/ports";
import type {
  PreviewEnvironmentLaunchOutcome,
  PreviewAccessPolicyPort,
  PreviewControlIdentity,
  PreviewDeploymentScopePort,
  PreviewEnvironmentObservationReaderPort,
  VclusterPreviewCleanupSnapshot,
  VclusterPreviewGatewayPort,
} from "$lib/server/application/ports";
import { PreviewDeploymentScopeDeniedError } from "$lib/server/application/preview-deployment-scope";

export { PreviewRuntimeIdentityChangedError } from "$lib/server/application/ports";

function runtimeControlIdentity(
  record: VclusterPreviewRecord,
): PreviewControlIdentity {
  const requestId = record.provenance?.requestId;
  if (
    !record.platformRevision ||
    !record.sourceRevision ||
    !record.catalogDigest ||
    typeof requestId !== "string" ||
    !requestId.trim()
  ) {
    throw new PreviewRuntimeIdentityChangedError(
      "preview runtime observation requires a complete immutable identity",
    );
  }
  return validatePreviewControlIdentity({
    previewName: safePreviewName(record.name),
    environmentRequestId: requestId.trim(),
    environmentPlatformRevision: record.platformRevision,
    environmentSourceRevision: record.sourceRevision,
    catalogDigest: record.catalogDigest as `sha256:${string}`,
  });
}

function authorizedRuntimeIdentity(record: VclusterPreviewRecord): string {
  const ownerId = record.owner?.id?.trim();
  if (!ownerId || !record.owner?.kind) {
    throw new PreviewRuntimeIdentityChangedError(
      "preview runtime observation requires an authoritative owner",
    );
  }
  return JSON.stringify({
    ...runtimeControlIdentity(record),
    ownerKind: record.owner.kind,
    ownerId,
  });
}

function sameRuntimeControlIdentity(
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

export type VclusterPreviewServiceDeps = {
  gateway: VclusterPreviewGatewayPort & PreviewEnvironmentObservationReaderPort;
  access: PreviewAccessPolicyPort;
  scope: Pick<
    PreviewDeploymentScopePort,
    "isControlPlane" | "allowsPreviewName"
  >;
  /** Repo slug (`owner/name`) for building `prUrl` (config `prPreviewRepo`). */
  previewRepo: string;
  /** Awake-preview cap fallback when the SEA omits `counts.max` (config
   * `vclusterPreviewMax`). SEA's own count wins when present. */
  maxPreviews: number;
};

/**
 * Application service for Tier-2 (vcluster full-isolation) previews. Owns the
 * cold-preview capacity-admission policy that used to live inline in the
 * vcluster route (`awake >= max`, with the config value as the fallback
 * ceiling), returns a
 * full capacity refusal AS DATA, decorates records with the UI-only `prUrl`,
 * and classifies the sleep 409 into a typed reason. The privileged cluster
 * calls all go through the injected gateway port.
 */
export class ApplicationVclusterPreviewService {
  constructor(private readonly deps: VclusterPreviewServiceDeps) {}

  /** Decorate a cluster record into the UI summary (adds `prUrl`). */
  private decorate(record: VclusterPreviewRecord): VclusterPreviewSummary {
    return {
      ...record,
      prUrl:
        record.prNumber != null
          ? `https://github.com/${this.deps.previewRepo}/pull/${record.prNumber}`
          : null,
    };
  }

  /** Present an application-service record through the existing UI DTO. */
  present(record: VclusterPreviewRecord): VclusterPreviewSummary {
    return this.decorate(record);
  }

  /** Present the new aggregate launch result through the existing Dev-hub DTO. */
  presentLaunch(
    outcome: PreviewEnvironmentLaunchOutcome,
  ): VclusterLaunchResult {
    if (!outcome.ok) return outcome;
    const environment = outcome.environment;
    return {
      ok: true,
      pooled: environment.runtime.pooled,
      preview: this.decorate({
        name: environment.name,
        phase: environment.runtime.phase,
        ready: environment.runtime.ready,
        url: environment.runtime.url,
        targetCluster: "dev",
        pool: environment.runtime.allocationId,
        state: environment.lifecycleState === "slept" ? "slept" : "hot",
        lifecycle:
          environment.lifecycle === "exclusive" ? null : environment.lifecycle,
        origin: {
          kind: environment.origin.kind,
          ...(environment.origin.reference == null
            ? {}
            : { reference: environment.origin.reference }),
        },
        legacyOrigin:
          environment.origin.kind === "pull-request" ? "pr" : "user",
        prNumber: null,
        expiresAt: environment.expiresAt,
        lastActive: environment.createdAt,
        protected: false,
        bootSeconds: null,
        platformRevision: environment.platformRevision,
        sourceRevision: environment.sourceRevision,
        profile:
          environment.profile === "app-live" ||
          environment.profile === "manifest-candidate"
            ? environment.profile
            : null,
        lane: environment.lane,
        mode: environment.mode,
        owner: { ...environment.owner },
        services: [...environment.services],
        provenance: { ...environment.provenance },
        trustedCode: true,
        allocation: { ...environment.allocation },
        images: { ...environment.imageOverrides },
        catalogDigest: null,
      }),
    };
  }

  /** List active previews + capacity counts (both decorated / passed through). */
  async list(): Promise<{
    previews: VclusterPreviewSummary[];
    counts: VclusterPreviewCounts | null;
  }> {
    this.requireControlPlane("preview fleet reads");
    const { previews, counts } = await this.deps.gateway.listWithCounts();
    return { previews: previews.map((p) => this.decorate(p)), counts };
  }

  /** Status of one preview (accepts a claimed alias). */
  async get(name: string): Promise<VclusterPreviewSummary> {
    this.requirePreviewName(name);
    return this.decorate(await this.deps.gateway.get(name));
  }

  /**
   * Observe runtime state for the exact record returned by the access policy.
   * The post-read identity fence prevents a teardown/recreate of the same name
   * from returning another owner's runtime state.
   */
  async observeRuntime(
    input: Readonly<{ name: string; actorUserId: string }>,
  ): Promise<VclusterPreviewRuntimeView> {
    const access = await this.deps.access.authorize(input);
    const authorizedPreview = access.preview;
    const expectedIdentity = authorizedRuntimeIdentity(authorizedPreview);
    const expectedControlIdentity = runtimeControlIdentity(authorizedPreview);
    const name = safePreviewName(authorizedPreview.name);
    const observation = await this.deps.gateway.observeRuntime(
      expectedControlIdentity,
    );
    const observed = observation.runtime;
    if (
      !sameRuntimeControlIdentity(
        observation.identity,
        expectedControlIdentity,
      ) ||
      observed.name !== name ||
      !sameRuntimeControlIdentity(
        observed.identity,
        expectedControlIdentity,
      ) ||
      authorizedRuntimeIdentity(observation.preview) !== expectedIdentity
    ) {
      throw new PreviewRuntimeIdentityChangedError();
    }
    return {
      name,
      reconciliationSucceeded: observed.reconciliationSucceeded,
      provision: {
        found: observed.upJob.found,
        active: observed.upJob.active,
        succeeded: observed.upJob.succeeded,
        failed: observed.upJob.failed,
      },
      services: observed.services.map((service) => ({
        service: service.service,
        containers: service.containers.map((container) => ({
          image: container.image,
          ready: container.ready,
        })),
      })),
    };
  }

  /** Guarded teardown convergence proof for a terminating preview. */
  cleanup(name: string): Promise<VclusterPreviewCleanupSnapshot> {
    this.requirePreviewName(name);
    return this.deps.gateway.cleanup(safePreviewName(name));
  }

  /**
   * Launch a cold preview behind admission control. Re-provisioning an existing preview of
   * the same name is always allowed. A full cluster returns `{ok:false,
   * reason:"capacity"}` — data, never a throw.
   */
  async launch(input: {
    name: string;
    user?: string;
  }): Promise<VclusterLaunchResult> {
    this.requireControlPlane("preview launch");
    const name = safePreviewName(input.name);
    const { previews, counts } = await this.deps.gateway.listWithCounts();
    const cap =
      counts?.max && counts.max > 0 ? counts.max : this.deps.maxPreviews;
    const awake = counts?.awake ?? previews.length;
    const alreadyThis = previews.some((p) => p.name === name);
    if (!alreadyThis && awake >= cap) {
      return {
        ok: false,
        reason: "capacity",
        awake,
        max: cap,
        message: `Preview capacity reached (${awake}/${cap}). Tear one down or sleep one first.`,
      };
    }
    const preview = await this.deps.gateway.provision({ name });
    return { ok: true, preview: this.decorate(preview), pooled: false };
  }

  /**
   * Sleep a preview. A gateway 409 is classified: "protected" when the preview
   * carries the operator exemption, else "pool-member" (a free/recycling pool
   * slot that stays claim-ready). Any other failure throws.
   */
  async sleep(name: string): Promise<PreviewSleepResult> {
    this.requireControlPlane("preview sleep");
    const outcome = await this.deps.gateway.sleep(name);
    if (outcome.ok) {
      return {
        ok: true,
        name: outcome.name,
        state: "slept",
        alreadySlept: outcome.alreadySlept,
      };
    }
    if (outcome.status === 409) {
      const reason = /protect/i.test(outcome.detail)
        ? "protected"
        : "pool-member";
      return { ok: false, reason, message: outcome.detail };
    }
    throw new Error(outcome.detail || `sleep failed (HTTP ${outcome.status})`);
  }

  /** Wake (resume) a slept preview by touching it — stamps last-active and, for
   * a slept preview, starts a resume Job (`resuming: true`). */
  async wake(name: string): Promise<PreviewWakeResult> {
    this.requireControlPlane("preview wake");
    const touched = await this.deps.gateway.touch(name);
    return {
      name: touched.name,
      state: touched.state,
      resuming: touched.resuming,
    };
  }

  /** Tear down a preview (drops the DB + `vcluster delete`). */
  async teardown(
    name: string,
    guard: Parameters<VclusterPreviewGatewayPort["teardown"]>[1],
  ): Promise<VclusterPreviewSummary> {
    this.requireControlPlane("preview teardown");
    if (!guard) throw new Error("preview teardown requires an ownership guard");
    return this.decorate(await this.deps.gateway.teardown(name, guard));
  }

  private requirePreviewName(name: string): void {
    if (!this.deps.scope.allowsPreviewName(name)) {
      throw new PreviewDeploymentScopeDeniedError(
        "cross-preview access is unavailable from a preview deployment",
      );
    }
  }

  private requireControlPlane(operation: string): void {
    if (!this.deps.scope.isControlPlane()) {
      throw new PreviewDeploymentScopeDeniedError(
        `${operation} is unavailable from a preview deployment`,
      );
    }
  }
}

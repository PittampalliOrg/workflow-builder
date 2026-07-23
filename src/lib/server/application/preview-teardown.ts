import type {
  PreviewAccessPolicyPort,
  PreviewArchivePort,
  PreviewArchiveResult,
  PreviewControlAdminAuthorizationPort,
  PreviewDeploymentScopePort,
  PreviewEnvironmentTeardownCommandPort,
  VclusterPreviewGatewayPort,
  WorkflowExecutionRepository,
} from "$lib/server/application/ports";
import type {
  VclusterPreviewRecord,
  VclusterPreviewTeardownTicket,
} from "$lib/types/dev-previews";
import { PreviewAccessDeniedError } from "$lib/server/application/preview-access";
import { PreviewDeploymentScopeDeniedError } from "$lib/server/application/preview-deployment-scope";
import { inspectPreviewParentWorkflowUse } from "$lib/server/application/preview-active-use";

const FULL_SHA = /^[0-9a-f]{40}$/;
const CANONICAL_REQUESTED_AT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/;
const UTC_EXPIRES_AT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/;
const MAX_QUARANTINE_REASON_LENGTH = 240;
const FAILED_LAUNCH_RECEIPT_TTL_MS = 30 * 60_000;

export type PreviewTeardownRefusalCode =
  | "ownership-incomplete"
  | "ownership-changed"
  | "protected"
  | "active-use"
  | "active-use-unverified"
  | "archive-required"
  | "failed-quarantine-ineligible"
  | "failed-quarantine-runtime-unavailable"
  | "failed-quarantine-runtime-mismatch"
  | "failed-quarantine-persistence-failed"
  | "discard-quarantine-persistence-failed";

/** A fail-closed destructive-operation refusal. HTTP adapters map this to 409. */
export class PreviewTeardownRefusedError extends Error {
  readonly status = 409;

  constructor(
    readonly code: PreviewTeardownRefusalCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PreviewTeardownRefusedError";
  }
}

export type PreviewTeardownInput = Readonly<{
  name: string;
  actorUserId: string;
  expectedRequestId: string;
  expectedSourceRevision: string;
  projectId?: string | null;
  forceFailed?: boolean;
  discardUnarchived?: boolean;
}>;

export type PreviewTeardownResult = Readonly<{
  archive: PreviewArchiveResult | null;
  preview: VclusterPreviewRecord;
  ticket: VclusterPreviewTeardownTicket | null;
}>;

type PreviewTeardownDeps = Readonly<{
  access: PreviewAccessPolicyPort;
  admins: PreviewControlAdminAuthorizationPort;
  archive: PreviewArchivePort;
  commands: PreviewEnvironmentTeardownCommandPort;
  previews: VclusterPreviewGatewayPort;
  executions: Pick<WorkflowExecutionRepository, "getById">;
  scope: Pick<PreviewDeploymentScopePort, "isControlPlane">;
  archiveOnTeardownEnabled: boolean;
  now?: () => Date;
}>;

type OwnedGuard = Readonly<{
  mode: "owned";
  requestId: string;
  sourceRevision: string;
}>;

type FailedQuarantineKind = "failed-launch" | "failed-preview";

/** Coordinates authorization, durability, and the exact destructive ownership guard. */
export class ApplicationPreviewTeardownService {
  constructor(private readonly deps: PreviewTeardownDeps) {}

  async teardown(input: PreviewTeardownInput): Promise<PreviewTeardownResult> {
    if (!this.deps.scope.isControlPlane()) {
      throw new PreviewDeploymentScopeDeniedError(
        "preview teardown is unavailable from a preview deployment",
      );
    }
    const access = await this.deps.access.authorize({
      name: input.name,
      actorUserId: input.actorUserId,
    });
    const actorUserId = input.actorUserId.trim();
    const guard = this.ownedGuard(access.preview);
    if (!guard) {
      throw new PreviewTeardownRefusedError(
        "ownership-incomplete",
        "Preview teardown ownership tuple is incomplete",
      );
    }
    if (
      input.expectedRequestId !== guard.requestId ||
      input.expectedSourceRevision !== guard.sourceRevision
    ) {
      throw new PreviewTeardownRefusedError(
        "ownership-changed",
        "Preview generation changed; refresh before tearing it down",
      );
    }
    if (access.preview.protected) {
      throw new PreviewTeardownRefusedError(
        "protected",
        "Preview is operator-protected; teardown refused",
      );
    }
    if (
      input.discardUnarchived === true &&
      !(await this.deps.admins.isPlatformAdmin(actorUserId))
    ) {
      throw new PreviewAccessDeniedError(
        "explicit unarchived preview discard requires a platform administrator",
      );
    }

    const parentUse = await inspectPreviewParentWorkflowUse(
      access.preview,
      this.deps.executions,
    );
    if (parentUse.state === "active") {
      throw new PreviewTeardownRefusedError(
        "active-use",
        `Preview parent workflow ${parentUse.executionId} is active; teardown refused`,
      );
    }
    if (parentUse.state === "unverified") {
      throw new PreviewTeardownRefusedError(
        "active-use-unverified",
        `Preview parent workflow ownership cannot be verified; teardown refused: ${parentUse.detail}`,
      );
    }

    const archiveRequired =
      access.preview.profile === "app-live" && access.preview.mode === "live";
    let archive: PreviewArchiveResult | null = null;
    let archiveFailure = "";
    let archiveThrew = false;
    if (archiveRequired || this.deps.archiveOnTeardownEnabled) {
      try {
        archive = await this.deps.archive.archivePreview({
          name: access.preview.name,
          userId: access.ownerId,
          projectId: access.actorIsOwner ? (input.projectId ?? null) : null,
        });
        if (!archive.archived)
          archiveFailure = archive.reason ?? "archive-incomplete";
      } catch (cause) {
        archiveThrew = true;
        archiveFailure = this.errorDetail(cause);
        if (!archiveRequired) {
          archive = {
            archived: false,
            preview: access.preview.name,
            reason: archiveFailure,
          };
        }
      }
    }

    const activeExecutionIds = archive?.activeExecutionIds ?? null;
    if (activeExecutionIds && activeExecutionIds.length > 0) {
      throw new PreviewTeardownRefusedError(
        "active-use",
        `Preview has active workflow executions (${activeExecutionIds.join(", ")}); teardown refused`,
      );
    }

    if (archiveRequired && archive?.archived !== true) {
      if (input.discardUnarchived === true) {
        if (activeExecutionIds === null) {
          throw new PreviewTeardownRefusedError(
            "active-use-unverified",
            "Preview workflow activity could not be verified; admin discard cannot bypass active-use protection",
          );
        }
        const discardedAt = (this.deps.now?.() ?? new Date()).toISOString();
        return this.persistQuarantineAndTeardown({
          preview: access.preview,
          ownerId: access.ownerId,
          projectId: access.actorIsOwner ? (input.projectId ?? null) : null,
          guard,
          attemptedArchive: archive,
          reason: this.boundReason(
            `archive incomplete; explicit platform-admin discard: ${archiveFailure || "archive-incomplete"}`,
          ),
          forcedAt: discardedAt,
          disposition: "admin-discard",
          authorizedByUserId: actorUserId,
          persistenceFailureCode: "discard-quarantine-persistence-failed",
          persistenceFailureSubject: "Admin-discard quarantine",
        });
      }
      if (input.forceFailed !== true) {
        throw new PreviewTeardownRefusedError(
          "archive-required",
          archiveThrew
            ? `Preview archive failed; teardown refused: ${archiveFailure || "unknown"}`
            : `Preview archive is incomplete; teardown refused: ${archiveFailure || "unknown"}`,
        );
      }
      return this.forceFailedQuarantine({
        preview: access.preview,
        ownerId: access.ownerId,
        projectId: access.actorIsOwner ? (input.projectId ?? null) : null,
        guard,
        attemptedArchive: archive,
        archiveFailure: archiveFailure || "archive-incomplete",
      });
    }

    const { preview, ticket } = await this.deps.commands.request(access.preview.name, {
      ...guard,
      ...(archive?.archived === true
        ? { archiveConfirmed: true as const }
        : {}),
    });
    return { archive, preview, ticket };
  }

  private async forceFailedQuarantine(
    input: Readonly<{
      preview: VclusterPreviewRecord;
      ownerId: string;
      projectId: string | null;
      guard: OwnedGuard;
      attemptedArchive: PreviewArchiveResult | null;
      archiveFailure: string;
    }>,
  ): Promise<PreviewTeardownResult> {
    const forcedAtDate = this.deps.now?.() ?? new Date();
    const quarantineKind = this.assertFailedQuarantineCandidate(
      input.preview,
      forcedAtDate.getTime(),
    );

    let runtime: Awaited<ReturnType<VclusterPreviewGatewayPort["runtime"]>>;
    try {
      runtime = await this.deps.previews.runtime(input.preview.name);
    } catch (cause) {
      throw new PreviewTeardownRefusedError(
        "failed-quarantine-runtime-unavailable",
        "Failed-preview runtime proof is unavailable; teardown refused",
        { cause },
      );
    }
    if (!this.matchesFailedRuntime(input.preview, runtime, quarantineKind)) {
      throw new PreviewTeardownRefusedError(
        "failed-quarantine-runtime-mismatch",
        "Failed-preview runtime proof does not match the authoritative preview; teardown refused",
      );
    }

    const forcedAt = forcedAtDate.toISOString();
    const cleanupScope =
      quarantineKind === "failed-preview"
        ? "failed-preview recovery"
        : "failed-launch cleanup";
    const reason = this.boundReason(
      `archive incomplete; forced ${cleanupScope}: ${input.archiveFailure}`,
    );
    return this.persistQuarantineAndTeardown({
      preview: input.preview,
      ownerId: input.ownerId,
      projectId: input.projectId,
      guard: input.guard,
      attemptedArchive: input.attemptedArchive,
      reason,
      forcedAt,
      disposition: "forced-quarantine",
      persistenceFailureCode: "failed-quarantine-persistence-failed",
      persistenceFailureSubject: "Failed-preview quarantine",
    });
  }

  private async persistQuarantineAndTeardown(
    input: Readonly<{
      preview: VclusterPreviewRecord;
      ownerId: string;
      projectId: string | null;
      guard: OwnedGuard;
      attemptedArchive: PreviewArchiveResult | null;
      reason: string;
      forcedAt: string;
      disposition: "forced-quarantine" | "admin-discard";
      authorizedByUserId?: string;
      persistenceFailureCode:
        | "failed-quarantine-persistence-failed"
        | "discard-quarantine-persistence-failed";
      persistenceFailureSubject: string;
    }>,
  ): Promise<PreviewTeardownResult> {
    let quarantine: PreviewArchiveResult;
    try {
      quarantine = await this.deps.archive.quarantinePreview({
        preview: {
          name: input.preview.name,
          pool: input.preview.pool,
          url: input.preview.url,
          expiresAt: input.preview.expiresAt as string,
        },
        userId: input.ownerId,
        projectId: input.projectId,
        reason: input.reason,
        forcedAt: input.forcedAt,
        graceExpiredAt: input.forcedAt,
        disposition: input.disposition,
        ...(input.authorizedByUserId
          ? { authorizedByUserId: input.authorizedByUserId }
          : {}),
        attemptedArchive: input.attemptedArchive,
      });
    } catch (cause) {
      throw new PreviewTeardownRefusedError(
        input.persistenceFailureCode,
        `${input.persistenceFailureSubject} could not be persisted; teardown refused`,
        { cause },
      );
    }
    if (
      quarantine.quarantined !== true ||
      quarantine.preview !== input.preview.name ||
      !quarantine.summaryFileId?.trim()
    ) {
      throw new PreviewTeardownRefusedError(
        input.persistenceFailureCode,
        `${input.persistenceFailureSubject} did not return durable loss-accounting proof; teardown refused`,
      );
    }

    const { preview, ticket } = await this.deps.commands.request(input.preview.name, {
      ...input.guard,
      archiveConfirmed: true,
      archiveQuarantine: {
        forcedAt: input.forcedAt,
        graceExpiredAt: input.forcedAt,
        reason: input.reason,
        summaryFileId: quarantine.summaryFileId,
      },
    });
    return { archive: quarantine, preview, ticket };
  }

  private assertFailedQuarantineCandidate(
    preview: VclusterPreviewRecord,
    now: number,
  ): FailedQuarantineKind {
    const requestedAt = this.parseUtcInstant(
      preview.provenance?.requestedAt,
      CANONICAL_REQUESTED_AT,
    );
    const requestedAtValid = requestedAt !== null && requestedAt <= now;
    const agedOut =
      requestedAtValid &&
      requestedAt <= now - FAILED_LAUNCH_RECEIPT_TTL_MS;
    const failedPhase =
      preview.phase === "failed" ||
      (preview.phase === "provisioning" && agedOut);
    const bootReceiptValid =
      preview.bootSeconds === null ||
      (typeof preview.bootSeconds === "number" &&
        Number.isFinite(preview.bootSeconds) &&
        preview.bootSeconds >= 0);
    const lastActive =
      preview.lastActive === null
        ? null
        : this.parseUtcInstant(preview.lastActive, UTC_EXPIRES_AT);
    const activityReceiptValid =
      preview.lastActive === null || (lastActive !== null && lastActive <= now);
    const postBoot = preview.bootSeconds !== null || preview.lastActive !== null;
    const quarantineKind: FailedQuarantineKind | null =
      requestedAtValid && failedPhase && !postBoot
        ? "failed-launch"
        : requestedAtValid && agedOut && failedPhase && postBoot
          ? "failed-preview"
          : null;
    if (
      preview.profile !== "app-live" ||
      preview.mode !== "live" ||
      quarantineKind === null ||
      preview.ready ||
      !bootReceiptValid ||
      !activityReceiptValid ||
      preview.trustedCode !== true ||
      preview.pool !== null ||
      preview.allocation?.kind !== "cold" ||
      this.parseUtcInstant(preview.expiresAt, UTC_EXPIRES_AT) === null ||
      !preview.services?.length ||
      new Set(preview.services).size !== preview.services.length
    ) {
      throw new PreviewTeardownRefusedError(
        "failed-quarantine-ineligible",
        "Preview is not eligible for explicit failed-preview quarantine; teardown refused",
      );
    }
    return quarantineKind;
  }

  private parseUtcInstant(value: unknown, pattern: RegExp): number | null {
    if (typeof value !== "string") return null;
    const match = pattern.exec(value);
    if (!match) return null;
    const [year, month, day, hour, minute, second] = match
      .slice(1, 7)
      .map((part) => Number.parseInt(part, 10));
    const fraction = match[7] ?? "";
    const millisecond = Number.parseInt(`${fraction}000`.slice(0, 3), 10);
    if (
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > 31 ||
      hour > 23 ||
      minute > 59 ||
      second > 59
    ) {
      return null;
    }
    const instant = new Date(0);
    instant.setUTCFullYear(year, month - 1, day);
    instant.setUTCHours(hour, minute, second, millisecond);
    if (
      instant.getUTCFullYear() !== year ||
      instant.getUTCMonth() !== month - 1 ||
      instant.getUTCDate() !== day ||
      instant.getUTCHours() !== hour ||
      instant.getUTCMinutes() !== minute ||
      instant.getUTCSeconds() !== second ||
      instant.getUTCMilliseconds() !== millisecond
    ) {
      return null;
    }
    return instant.getTime();
  }

  private matchesFailedRuntime(
    preview: VclusterPreviewRecord,
    runtime: Awaited<ReturnType<VclusterPreviewGatewayPort["runtime"]>>,
    quarantineKind: FailedQuarantineKind,
  ): boolean {
    const expectedServices = [...(preview.services ?? [])].sort();
    const observedServices = runtime.services
      .map((service) => service.service)
      .sort();
    // A later sync wave can fail after a successful boot. Failed-launch remains
    // marker-strict; post-boot recovery instead requires current degraded
    // container evidence before persisting explicit loss accounting.
    const exactFailedJob =
      quarantineKind === "failed-launch" &&
      preview.phase === "failed" &&
      runtime.upJob.found &&
      !runtime.upJob.active &&
      !runtime.upJob.succeeded &&
      runtime.upJob.failed;
    const exactAgedOutJob =
      quarantineKind === "failed-launch" &&
      preview.phase === "provisioning" &&
      !runtime.upJob.found &&
      !runtime.upJob.active &&
      !runtime.upJob.succeeded &&
      !runtime.upJob.failed;
    const exactPostBootJob =
      quarantineKind === "failed-preview" &&
      ((runtime.upJob.found &&
        !runtime.upJob.active &&
        runtime.upJob.succeeded &&
        !runtime.upJob.failed) ||
        (!runtime.upJob.found &&
          !runtime.upJob.active &&
          !runtime.upJob.succeeded &&
          !runtime.upJob.failed));
    const failedRuntimeProof =
      quarantineKind === "failed-launch"
        ? runtime.reconciliationSucceeded === false
        : runtime.services.some(
            (service) =>
              !service.containers.some((container) => container.ready),
          );
    return (
      runtime.name === preview.name &&
      runtime.resourceName === preview.name &&
      runtime.upJob.name === `vcpreview-up-${preview.name}` &&
      (exactFailedJob || exactAgedOutJob || exactPostBootJob) &&
      failedRuntimeProof &&
      new Set(observedServices).size === observedServices.length &&
      expectedServices.length === observedServices.length &&
      expectedServices.every(
        (service, index) => service === observedServices[index],
      )
    );
  }

  private ownedGuard(preview: VclusterPreviewRecord): OwnedGuard | null {
    const requestId =
      typeof preview.provenance?.requestId === "string"
        ? preview.provenance.requestId
        : "";
    if (!requestId || !FULL_SHA.test(preview.sourceRevision ?? "")) return null;
    return {
      mode: "owned",
      requestId,
      sourceRevision: preview.sourceRevision as string,
    };
  }

  private boundReason(reason: string): string {
    return reason
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, MAX_QUARANTINE_REASON_LENGTH);
  }

  private errorDetail(cause: unknown): string {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

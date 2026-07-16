import { createHash } from "node:crypto";
import type {
  PreviewControlAdminAuthorizationPort,
  PreviewDeploymentScopePort,
  PreviewDevelopmentEnvironmentLaunchInput,
  PreviewDevelopmentEnvironmentPort,
  PreviewDevelopmentEnvironmentTeardownPort,
  PreviewDevelopmentTarget,
  PreviewEnvironment,
  PreviewEnvironmentTeardownStatusPort,
  PreviewEnvironmentUserLaunchPort,
  PreviewEnvironmentObservationReaderPort,
  VclusterPreviewGatewayPort,
  WorkflowExecutionRepository,
  PreviewControlIdentity,
} from "$lib/server/application/ports";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import type {
  VclusterPreviewRecord,
  VclusterPreviewTeardownTicket,
} from "$lib/types/dev-previews";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const PREVIEW_NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SERVICE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OPERATION_ID =
  /^pdt-(launch-environment|get-environment-status|teardown-environment|get-environment-teardown-status)-[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_SERVICES = 16;

type OperationKind =
  | "launch-environment"
  | "get-environment-status"
  | "teardown-environment"
  | "get-environment-teardown-status";

export type PreviewDevelopmentEnvironmentErrorCode =
  | "invalid-request"
  | "not-found"
  | "not-ready"
  | "unauthorized"
  | "contract-mismatch"
  | "upstream-failure";

export class PreviewDevelopmentEnvironmentError extends Error {
  constructor(
    public readonly code: PreviewDevelopmentEnvironmentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PreviewDevelopmentEnvironmentError";
  }
}

type Deps = Readonly<{
  executions: Pick<WorkflowExecutionRepository, "getById">;
  admins: PreviewControlAdminAuthorizationPort;
  scope: Pick<PreviewDeploymentScopePort, "isControlPlane">;
  environments: PreviewEnvironmentUserLaunchPort;
  previews: Pick<VclusterPreviewGatewayPort, "get" | "cleanup"> &
    Pick<PreviewEnvironmentObservationReaderPort, "observeRuntime"> &
    PreviewEnvironmentTeardownStatusPort;
  teardown: PreviewDevelopmentEnvironmentTeardownPort;
}>;

type Actor = Readonly<{ userId: string; projectId: string | null }>;

function fail(
  code: PreviewDevelopmentEnvironmentErrorCode,
  message: string,
  options?: ErrorOptions,
): never {
  throw new PreviewDevelopmentEnvironmentError(code, message, options);
}

function validateOperationId(operationId: string, kind: OperationKind): string {
  if (
    typeof operationId !== "string" ||
    !OPERATION_ID.test(operationId) ||
    !operationId.startsWith(`pdt-${kind}-`)
  ) {
    return fail("invalid-request", `invalid ${kind} operation id`);
  }
  return operationId;
}

function normalizeLaunch(
  input: PreviewDevelopmentEnvironmentLaunchInput,
): PreviewDevelopmentEnvironmentLaunchInput {
  if (
    !input ||
    typeof input !== "object" ||
    !PREVIEW_NAME.test(input.environmentName) ||
    !Array.isArray(input.services) ||
    input.services.length < 1 ||
    input.services.length > MAX_SERVICES ||
    input.services.some(
      (service) => typeof service !== "string" || !SERVICE.test(service),
    ) ||
    new Set(input.services).size !== input.services.length ||
    !Number.isInteger(input.ttlHours) ||
    input.ttlHours < 2 ||
    input.ttlHours > 24 ||
    typeof input.retainAfterCompletion !== "boolean"
  ) {
    return fail(
      "invalid-request",
      "preview environment launch input is invalid",
    );
  }
  return Object.freeze({
    environmentName: input.environmentName,
    services: Object.freeze([...input.services].sort()),
    ttlHours: input.ttlHours,
    retainAfterCompletion: input.retainAfterCompletion,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function previewDevelopmentParentBindingPrefix(
  parentExecutionId: string,
): string {
  return `workflow-execution:sha256:${sha256(parentExecutionId)}:launch:sha256:`;
}

function launchBinding(input: {
  parentExecutionId: string;
  operationId: string;
  launch: PreviewDevelopmentEnvironmentLaunchInput;
}): string {
  const digest = sha256(
    [
      "preview-development-environment/v1",
      input.parentExecutionId,
      input.operationId,
      input.launch.environmentName,
      [...input.launch.services].sort().join(","),
      String(input.launch.ttlHours),
      String(input.launch.retainAfterCompletion),
      "",
    ].join("\0"),
  );
  return `${previewDevelopmentParentBindingPrefix(input.parentExecutionId)}${digest}`;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function targetFrom(input: {
  name: string;
  requestId: unknown;
  platformRevision: unknown;
  sourceRevision: unknown;
  catalogDigest: unknown;
}): PreviewDevelopmentTarget {
  try {
    const identity = validatePreviewControlIdentity({
      previewName: input.name,
      environmentRequestId:
        typeof input.requestId === "string" ? input.requestId : "",
      environmentPlatformRevision:
        typeof input.platformRevision === "string"
          ? input.platformRevision
          : "",
      environmentSourceRevision:
        typeof input.sourceRevision === "string" ? input.sourceRevision : "",
      catalogDigest:
        typeof input.catalogDigest === "string" &&
        SHA256.test(input.catalogDigest)
          ? (input.catalogDigest as `sha256:${string}`)
          : ("" as `sha256:${string}`),
    });
    return Object.freeze({
      previewName: identity.previewName,
      environmentRequestId: identity.environmentRequestId,
      platformRevision: identity.environmentPlatformRevision,
      sourceRevision: identity.environmentSourceRevision,
      catalogDigest: identity.catalogDigest,
    });
  } catch (cause) {
    return fail(
      "contract-mismatch",
      "preview environment has an incomplete immutable target tuple",
      { cause },
    );
  }
}

function sameTarget(
  left: PreviewDevelopmentTarget,
  right: PreviewDevelopmentTarget,
): boolean {
  return (
    left.previewName === right.previewName &&
    left.environmentRequestId === right.environmentRequestId &&
    left.platformRevision === right.platformRevision &&
    left.sourceRevision === right.sourceRevision &&
    left.catalogDigest === right.catalogDigest
  );
}

function targetIdentity(target: PreviewDevelopmentTarget): PreviewControlIdentity {
  return {
    previewName: target.previewName,
    environmentRequestId: target.environmentRequestId,
    environmentPlatformRevision: target.platformRevision,
    environmentSourceRevision: target.sourceRevision,
    catalogDigest: target.catalogDigest,
  };
}

function recordProvenance(record: VclusterPreviewRecord): {
  requestId: unknown;
  parentEnvironmentId: unknown;
} {
  return {
    requestId: record.provenance?.requestId,
    parentEnvironmentId: record.provenance?.parentEnvironmentId,
  };
}

/**
 * Host-only coordinator for one PreviewEnvironment generation. Network and
 * cluster concerns stay in the injected launch, inventory, and teardown ports.
 */
export class ApplicationPreviewDevelopmentEnvironmentService implements PreviewDevelopmentEnvironmentPort {
  constructor(private readonly deps: Deps) {}

  async launchEnvironment(
    input: Parameters<
      PreviewDevelopmentEnvironmentPort["launchEnvironment"]
    >[0],
  ) {
    const actor = await this.resolveActor(input.parentExecutionId);
    const operationId = validateOperationId(
      input.operationId,
      "launch-environment",
    );
    const launch = normalizeLaunch(input.launch);
    const binding = launchBinding({
      parentExecutionId: input.parentExecutionId,
      operationId,
      launch,
    });

    let outcome;
    try {
      outcome = await this.deps.environments.launchForUser({
        name: launch.environmentName,
        userId: actor.userId,
        workflowExecutionId: input.parentExecutionId,
        profile: "app-live",
        lane: "application",
        capabilities: ["service-live-sync"],
        services: launch.services,
        ttlHours: launch.ttlHours,
        lifecycle: "retained",
        allocation: { kind: "cold" },
        provenance: { parentEnvironmentId: binding },
      });
    } catch (cause) {
      return fail("upstream-failure", "preview environment launch failed", {
        cause,
      });
    }

    if (!outcome.ok) {
      if (outcome.reason === "capacity") {
        return fail("not-ready", outcome.message);
      }
      const existing = await this.readPreview(
        launch.environmentName,
        "existing preview environment could not be read",
      );
      const target = this.assertOwnedRecord({
        record: existing,
        actor,
        parentExecutionId: input.parentExecutionId,
        exactBinding: binding,
        services: launch.services,
      });
      return {
        kind: "launch-environment" as const,
        operationId,
        target,
        phase: existing.phase,
        ready: existing.ready,
        url: existing.url,
        reused: true,
      };
    }

    const environment = outcome.environment;
    const target = this.assertLaunchedEnvironment({
      environment,
      actor,
      parentExecutionId: input.parentExecutionId,
      binding,
      launch,
    });
    return {
      kind: "launch-environment" as const,
      operationId,
      target,
      phase: environment.runtime.phase,
      ready: environment.runtime.ready,
      url: environment.runtime.url,
      reused: false,
    };
  }

  async getEnvironmentStatus(
    input: Parameters<
      PreviewDevelopmentEnvironmentPort["getEnvironmentStatus"]
    >[0],
  ) {
    const actor = await this.resolveActor(input.parentExecutionId);
    const operationId = validateOperationId(
      input.operationId,
      "get-environment-status",
    );
    const record = await this.readTargetPreview(
      input.target,
      "preview environment status could not be read",
    );
    const target = this.assertOwnedRecord({
      record,
      actor,
      parentExecutionId: input.parentExecutionId,
    });
    if (!sameTarget(target, input.target)) {
      return fail(
        "contract-mismatch",
        "preview environment generation changed while reading status",
      );
    }
    return {
      kind: "get-environment-status" as const,
      operationId,
      target,
      phase: record.phase,
      ready: record.ready,
      url: record.url,
    };
  }

  async teardownEnvironment(
    input: Parameters<
      PreviewDevelopmentEnvironmentPort["teardownEnvironment"]
    >[0],
  ) {
    const actor = await this.resolveActor(input.parentExecutionId);
    const operationId = validateOperationId(
      input.operationId,
      "teardown-environment",
    );
    const requestedTarget = targetFrom({
      name: input.target.previewName,
      requestId: input.target.environmentRequestId,
      platformRevision: input.target.platformRevision,
      sourceRevision: input.target.sourceRevision,
      catalogDigest: input.target.catalogDigest,
    });
    let record: VclusterPreviewRecord;
    try {
      record = await this.readTargetPreview(
        requestedTarget,
        "preview environment could not be read before teardown",
      );
    } catch (cause) {
      try {
        const cleanup = await this.deps.previews.cleanup(
          requestedTarget.previewName,
        );
        if (cleanup.complete) {
          return {
            kind: "teardown-environment" as const,
            operationId,
            target: requestedTarget,
            phase: "absent",
            ticket: null,
            complete: true,
          };
        }
      } catch {
        // Preserve the authoritative read failure when absence is not proved.
      }
      throw cause;
    }
    const target = this.assertOwnedRecord({
      record,
      actor,
      parentExecutionId: input.parentExecutionId,
    });
    if (!sameTarget(target, input.target)) {
      return fail(
        "contract-mismatch",
        "preview environment generation changed before teardown",
      );
    }

    let result;
    try {
      result = await this.deps.teardown.teardown({
        name: target.previewName,
        actorUserId: actor.userId,
        expectedRequestId: target.environmentRequestId,
        expectedSourceRevision: target.sourceRevision,
        projectId: actor.projectId,
        discardUnarchived: true,
      });
    } catch (cause) {
      return fail("upstream-failure", "preview environment teardown failed", {
        cause,
      });
    }
    this.assertTicket(result.ticket, target);
    return {
      kind: "teardown-environment" as const,
      operationId,
      target,
      phase: result.preview.phase,
      ticket: result.ticket,
      complete: result.ticket === null,
    };
  }

  async getEnvironmentTeardownStatus(
    input: Parameters<
      PreviewDevelopmentEnvironmentPort["getEnvironmentTeardownStatus"]
    >[0],
  ) {
    await this.resolveActor(input.parentExecutionId);
    const operationId = validateOperationId(
      input.operationId,
      "get-environment-teardown-status",
    );
    this.assertTicket(input.ticket, input.target, false);
    let cleanup;
    try {
      cleanup = await this.deps.previews.status(input.ticket);
    } catch (cause) {
      return fail(
        "upstream-failure",
        "preview environment teardown status failed",
        { cause },
      );
    }
    if (cleanup.name !== input.target.previewName) {
      return fail(
        "contract-mismatch",
        "preview cleanup proof does not match the target generation",
      );
    }
    return {
      kind: "get-environment-teardown-status" as const,
      operationId,
      target: input.target,
      ticket: input.ticket,
      cleanup,
      complete: cleanup.complete,
    };
  }

  private async resolveActor(parentExecutionId: string): Promise<Actor> {
    if (!this.deps.scope.isControlPlane()) {
      return fail(
        "unauthorized",
        "host preview environment commands require the control-plane BFF",
      );
    }
    if (
      typeof parentExecutionId !== "string" ||
      !SAFE_ID.test(parentExecutionId)
    ) {
      return fail("invalid-request", "parent execution id is invalid");
    }
    const execution = await this.deps.executions.getById(parentExecutionId);
    if (!execution) {
      return fail("not-found", "parent workflow execution was not found");
    }
    if (execution.status !== "pending" && execution.status !== "running") {
      return fail(
        "contract-mismatch",
        "parent workflow execution is not active",
      );
    }
    if (!(await this.deps.admins.isPlatformAdmin(execution.userId))) {
      return fail(
        "unauthorized",
        "parent workflow actor is not a platform administrator",
      );
    }
    return { userId: execution.userId, projectId: execution.projectId };
  }

  private async readPreview(name: string, message: string) {
    if (!PREVIEW_NAME.test(name)) {
      return fail("invalid-request", "preview environment name is invalid");
    }
    try {
      return await this.deps.previews.get(name);
    } catch (cause) {
      return fail("upstream-failure", message, { cause });
    }
  }

  private async readTargetPreview(target: PreviewDevelopmentTarget, message: string) {
    try {
      return (await this.deps.previews.observeRuntime(targetIdentity(target))).preview;
    } catch (cause) {
      return fail("upstream-failure", message, { cause });
    }
  }

  private assertLaunchedEnvironment(input: {
    environment: PreviewEnvironment;
    actor: Actor;
    parentExecutionId: string;
    binding: string;
    launch: PreviewDevelopmentEnvironmentLaunchInput;
  }): PreviewDevelopmentTarget {
    const environment = input.environment;
    if (
      environment.name !== input.launch.environmentName ||
      environment.profile !== "app-live" ||
      environment.lane !== "application" ||
      environment.mode !== "live" ||
      environment.owner.kind !== "user" ||
      environment.owner.id !== input.actor.userId ||
      environment.origin.kind !== "workflow" ||
      environment.origin.reference !== input.parentExecutionId ||
      environment.lifecycle !== "retained" ||
      environment.allocation.kind !== "cold" ||
      environment.ttlHours !== input.launch.ttlHours ||
      !sameStrings(environment.services, input.launch.services) ||
      environment.provenance.parentEnvironmentId !== input.binding
    ) {
      return fail(
        "contract-mismatch",
        "launched preview environment does not match the host workflow contract",
      );
    }
    return targetFrom({
      name: environment.name,
      requestId: environment.provenance.requestId,
      platformRevision: environment.platformRevision,
      sourceRevision: environment.sourceRevision,
      catalogDigest: environment.catalogDigest,
    });
  }

  private assertOwnedRecord(input: {
    record: VclusterPreviewRecord;
    actor: Actor;
    parentExecutionId: string;
    exactBinding?: string;
    services?: readonly string[];
  }): PreviewDevelopmentTarget {
    const provenance = recordProvenance(input.record);
    const binding =
      typeof provenance.parentEnvironmentId === "string"
        ? provenance.parentEnvironmentId
        : "";
    const expectedPrefix = previewDevelopmentParentBindingPrefix(
      input.parentExecutionId,
    );
    if (
      input.record.profile !== "app-live" ||
      input.record.lane !== "application" ||
      input.record.mode !== "live" ||
      input.record.owner?.kind !== "user" ||
      input.record.owner.id !== input.actor.userId ||
      input.record.origin?.kind !== "workflow" ||
      input.record.origin.reference !== input.parentExecutionId ||
      input.record.lifecycle !== "retained" ||
      input.record.allocation?.kind !== "cold" ||
      input.record.trustedCode !== true ||
      !binding.startsWith(expectedPrefix) ||
      binding.length !== expectedPrefix.length + 64 ||
      (input.exactBinding !== undefined && binding !== input.exactBinding) ||
      (input.services !== undefined &&
        (!input.record.services ||
          !sameStrings(input.record.services, input.services)))
    ) {
      return fail(
        "contract-mismatch",
        "preview environment is not owned by this host workflow launch",
      );
    }
    return targetFrom({
      name: input.record.name,
      requestId: provenance.requestId,
      platformRevision: input.record.platformRevision,
      sourceRevision: input.record.sourceRevision,
      catalogDigest: input.record.catalogDigest,
    });
  }

  private assertTicket(
    ticket: VclusterPreviewTeardownTicket | null,
    target: PreviewDevelopmentTarget,
    allowNull = true,
  ): void {
    if (ticket === null) {
      if (allowNull) return;
      return fail("invalid-request", "preview teardown ticket is required");
    }
    if (
      ticket.name !== target.previewName ||
      ticket.requestId !== target.environmentRequestId ||
      ticket.sourceRevision !== target.sourceRevision ||
      typeof ticket.environmentUid !== "string" ||
      !ticket.environmentUid ||
      typeof ticket.signature !== "string" ||
      !/^[0-9a-f]{64}$/.test(ticket.signature)
    ) {
      return fail(
        "contract-mismatch",
        "preview teardown ticket does not match the target generation",
      );
    }
  }
}

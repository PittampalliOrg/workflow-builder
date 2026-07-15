import type {
  DevEnvironmentTeardownBody,
  DevEnvironmentTeardownInput,
  DevEnvironmentTeardownPort,
  DevEnvironmentTeardownResult,
  DevPreviewSourceFreezeReceipt,
  DevPreviewSourceFreezeResult,
  PreviewEnvironmentProvisioner,
  PreviewSessionContinuationPort,
  PreviewSessionContinuationPromotionBody,
  SessionLifecycleController,
  WorkflowArtifactRecord,
  WorkflowDataService,
  WorkflowExecutionLifecycleControllerPort,
} from "$lib/server/application/ports";
import { latestWorkflowArtifact } from "$lib/server/application/workflow-code-version-order";

type TeardownWorkflowData = Pick<
  WorkflowDataService,
  | "getDevEnvironmentOrPending"
  | "getDevEnvironmentTeardownTarget"
  | "getScopedExecutionById"
  | "listDevEnvironmentGroups"
  | "isPlatformAdmin"
  | "listWorkflowArtifactsByExecutionId"
  | "getWorkflowArtifactForExecution"
  | "mergeWorkflowArtifactMetadata"
>;

type PromotedCheckpoint = Readonly<{
  status: "promoted";
  artifactId: string;
  receiptId: string;
  repository: string;
  pullRequestNumber: number;
  branch: string;
  headSha: string;
  generation: string;
  services: readonly DevPreviewSourceFreezeReceipt[];
}>;

type VerifiedPromotion = Readonly<{
  receiptId: string;
  centralArtifactId: string;
  repository: string;
  pullRequestNumber: number;
  prUrl: string;
  branch: string;
  baseSha: string;
  headSha: string;
}>;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type TeardownErrorResult = Extract<
  DevEnvironmentTeardownResult,
  { status: "error" }
>;

type CheckpointPreparationResult =
  | Readonly<{ status: "prepared"; checkpoint: PromotedCheckpoint }>
  | TeardownErrorResult;

/**
 * Product teardown policy. The HTTP route authenticates and delegates; this
 * service owns the freeze -> capture -> promotion -> cleanup state machine.
 */
export class ApplicationDevEnvironmentTeardownService
  implements DevEnvironmentTeardownPort
{
  constructor(
    private readonly deps: Readonly<{
      workflowData: TeardownWorkflowData;
      continuation: PreviewSessionContinuationPort;
      previews: PreviewEnvironmentProvisioner;
      sessions: Pick<SessionLifecycleController, "stopSession">;
      executions: Pick<WorkflowExecutionLifecycleControllerPort, "stopExecution">;
      now?: () => Date;
    }>,
  ) {}

  async teardown(
    input: DevEnvironmentTeardownInput,
  ): Promise<DevEnvironmentTeardownResult> {
    const scope = {
      executionId: input.executionId,
      projectId: input.projectId ?? null,
    };
    const activeEnvironment =
      await this.deps.workflowData.getDevEnvironmentOrPending(scope);
    const environment =
      activeEnvironment ??
      (await this.deps.workflowData.getDevEnvironmentTeardownTarget(scope));
    if (!environment) {
      return productError(input.executionId, 404, "Dev environment not found");
    }

    const discardUncaptured = input.discardUncaptured === true;
    const isPlatformAdmin = await this.deps.workflowData.isPlatformAdmin(
      input.userId,
    );
    if (discardUncaptured && !isPlatformAdmin) {
      return productError(
        input.executionId,
        403,
        "Discarding uncaptured preview changes requires a platform administrator",
      );
    }
    if (activeEnvironment && !discardUncaptured && !isPlatformAdmin) {
      return productError(
        input.executionId,
        403,
        "Checkpoint-preserving preview teardown requires a platform administrator",
      );
    }

    let sourceCheckpoint: PromotedCheckpoint | null = null;
    if (activeEnvironment && !discardUncaptured) {
      const requestedServices = await this.requestedServiceSet(
        input.executionId,
        input.userId,
        input.projectId ?? null,
      );
      if (!requestedServices) {
        return checkpointError(
          input.executionId,
          "The preview service set is incomplete; teardown was not started",
        );
      }
      sourceCheckpoint = await findTeardownCheckpoint(
        this.deps.workflowData,
        input.executionId,
        requestedServices,
      );
      if (!sourceCheckpoint) {
        const services = await this.exactActiveServiceSet(
          input.executionId,
          input.projectId ?? null,
          requestedServices,
        );
        if (!services) {
          return checkpointError(
            input.executionId,
            "The preview service set is incomplete; teardown was not started",
          );
        }

        let freeze: DevPreviewSourceFreezeResult;
        try {
          freeze = await this.deps.previews.freezeSourcesForTeardown({
            executionId: input.executionId,
            services,
          });
        } catch (cause) {
          return checkpointError(
            input.executionId,
            `${message(cause)}. Teardown was not started`,
          );
        }
        if (!validFreeze(freeze, input.executionId, services)) {
          return checkpointError(
            input.executionId,
            "The live-sync source freeze receipt is invalid; teardown was not started",
          );
        }

        sourceCheckpoint = await findTeardownCheckpoint(
          this.deps.workflowData,
          input.executionId,
          services,
          freeze,
        );
        if (!sourceCheckpoint) {
          const prepared = await this.prepareCheckpoint(input, services, freeze);
          if (prepared.status === "error") return prepared;
          sourceCheckpoint = prepared.checkpoint;
        }
      }
    }

    const preview = await this.deps.previews.teardown({
      executionId: input.executionId,
      sourceCheckpoint: discardUncaptured
        ? { status: "discard-authorized" }
        : sourceCheckpoint ?? { status: "teardown-resume" },
    });
    return this.finishLifecycle(input.executionId, environment, preview);
  }

  private async requestedServiceSet(
    executionId: string,
    userId: string,
    projectId: string | null,
  ): Promise<string[] | null> {
    const execution = await this.deps.workflowData.getScopedExecutionById({
      executionId,
      userId,
      projectId,
    });
    return requestedServicesFromExecutionInput(execution?.input);
  }

  private async exactActiveServiceSet(
    executionId: string,
    projectId: string | null,
    requested: readonly string[],
  ): Promise<string[] | null> {
    const groups = await this.deps.workflowData.listDevEnvironmentGroups({
      projectId,
    });
    const group = groups.find((candidate) => candidate.executionId === executionId);
    if (!group) return null;
    const observed = group.services.map(({ service }) => service);
    if (!validExactServiceList(observed)) return null;
    return sameStrings(requested, observed) ? [...requested].sort() : null;
  }

  private async prepareCheckpoint(
    input: DevEnvironmentTeardownInput,
    services: readonly string[],
    freeze: DevPreviewSourceFreezeResult,
  ): Promise<CheckpointPreparationResult> {
    let artifactId = await latestPromotedArtifactForFreeze(
      this.deps.workflowData,
      input.executionId,
      freeze,
    );
    if (!artifactId) {
      const capture = await this.deps.continuation.continue({
        executionId: input.executionId,
        userId: input.userId,
        projectId: input.projectId ?? null,
        action: { action: "capture", services },
      });
      if (
        capture.status !== "ok" ||
        capture.body.action !== "capture" ||
        capture.body.ok !== true
      ) {
        const detail =
          capture.status === "error"
            ? capture.message
            : "The frozen live-sync generation could not be captured";
        return checkpointError(
          input.executionId,
          `${detail}. Retry checkpointing, or explicitly discard the frozen changes`,
        );
      }
      artifactId = capture.body.artifactId ?? null;
      if (!artifactId) {
        return checkpointError(
          input.executionId,
          "The captured preview checkpoint has no durable artifact identity",
        );
      }
    }
    let artifact =
      await this.deps.workflowData.getWorkflowArtifactForExecution({
        executionId: input.executionId,
        artifactId,
      });
    if (
      !isStrictSourceArtifact(artifact) ||
      !artifactMatchesFreeze(artifact, freeze)
    ) {
      return checkpointError(
        input.executionId,
        "The captured checkpoint does not match the frozen source generation",
      );
    }

    // Always cross physical control, even when a local projection exists. The
    // idempotent replay revalidates the append-only receipt and live draft PR.
    const promoted = await this.deps.continuation.continue({
      executionId: input.executionId,
      userId: input.userId,
      projectId: input.projectId ?? null,
      action: { action: "promote", artifactId, draft: true },
    });
    if (
      promoted.status !== "ok" ||
      promoted.body.action !== "promote" ||
      promoted.body.ok !== true ||
      promoted.body.artifactId !== artifactId
    ) {
      const detail =
        promoted.status === "error"
          ? promoted.message
          : "The frozen checkpoint could not be promoted to a draft pull request";
      return checkpointError(
        input.executionId,
        `${detail}. Teardown was not started`,
      );
    }
    artifact = await this.deps.workflowData.getWorkflowArtifactForExecution({
      executionId: input.executionId,
      artifactId,
    });
    const promotion = verifiedPromotion(artifact?.metadata?.promotion);
    if (
      !promotion ||
      !isStrictSourceArtifact(artifact) ||
      !artifactMatchesFreeze(artifact, freeze) ||
      !matchesPromotionResponse(promotion, promoted.body)
    ) {
      return checkpointError(
        input.executionId,
        "The draft pull-request receipt could not be verified after promotion; teardown was not started",
      );
    }

    const marker = {
      version: 2,
      executionId: input.executionId,
      artifactId,
      receiptId: promotion.receiptId,
      centralArtifactId: promotion.centralArtifactId,
      repository: promotion.repository,
      pullRequestNumber: promotion.pullRequestNumber,
      prUrl: promotion.prUrl,
      branch: promotion.branch,
      headSha: promotion.headSha,
      generation: freeze.generation,
      services: freeze.services.map((receipt) => ({ ...receipt })),
      requestedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      requestedBy: input.userId,
    };
    const marked = await this.deps.workflowData.mergeWorkflowArtifactMetadata({
      executionId: input.executionId,
      artifactId,
      patch: { teardownCheckpoint: marker },
      ifAbsentMetadataKey: "teardownCheckpoint",
    });
    if (!marked) {
      const existing = await findTeardownCheckpoint(
        this.deps.workflowData,
        input.executionId,
        services,
        freeze,
      );
      if (!existing) {
        return checkpointError(
          input.executionId,
          "The teardown checkpoint could not be recorded; teardown was not started",
        );
      }
      return { status: "prepared", checkpoint: existing };
    }
    return {
      status: "prepared",
      checkpoint: checkpointFrom(artifactId, promotion, freeze),
    };
  }

  private async finishLifecycle(
    executionId: string,
    environment: Readonly<{
      sessionId: string | null;
      runStatus: string | null;
    }>,
    preview: Readonly<{
      ok: boolean;
      complete: boolean;
      pending: boolean;
      sandboxName: string | null;
    }>,
  ): Promise<DevEnvironmentTeardownResult> {
    const reason = "Dev environment torn down by user";
    const lifecycleErrors: string[] = [];
    const stop = async (
      kind: "session" | "workflowExecution",
      id: string,
    ): Promise<string | null> => {
      try {
        const result =
          kind === "session"
            ? await this.deps.sessions.stopSession(id, { mode: "purge", reason })
            : await this.deps.executions.stopExecution(id, {
                mode: "purge",
                reason,
              });
        const state = result.notFound ? "notFound" : result.state;
        if (!state || !["confirmed", "stopping", "notFound"].includes(state)) {
          throw new Error(`unexpected lifecycle state ${String(state)}`);
        }
        return state;
      } catch (cause) {
        const detail = message(cause);
        lifecycleErrors.push(`${kind}: ${detail}`);
        console.warn(`[dev-environments] ${kind} purge failed:`, detail);
        return null;
      }
    };

    const sessionStopped =
      preview.complete && environment.sessionId
        ? await stop("session", environment.sessionId)
        : null;
    const runStopped =
      preview.complete &&
      environment.runStatus &&
      !["success", "error", "cancelled"].includes(environment.runStatus)
        ? await stop("workflowExecution", executionId)
        : null;
    const lifecyclePending = [sessionStopped, runStopped].includes("stopping");
    const ok = preview.ok && lifecycleErrors.length === 0;
    const pending = preview.pending || lifecyclePending;
    const complete = preview.complete && ok && !pending;
    const body: DevEnvironmentTeardownBody = {
      ok,
      complete,
      pending,
      executionId,
      sandboxName: preview.sandboxName,
      sessionStopped,
      runStopped,
      ...(lifecycleErrors.length
        ? { error: `lifecycle cleanup failed: ${lifecycleErrors.join("; ")}` }
        : {}),
    };
    const httpStatus = !ok ? 503 : pending ? 202 : complete ? 200 : 503;
    return httpStatus === 200 || httpStatus === 202
      ? { status: "ok", httpStatus, body }
      : { status: "error", httpStatus: 503, body };
  }
}

async function latestPromotedArtifactForFreeze(
  workflowData: TeardownWorkflowData,
  executionId: string,
  freeze: DevPreviewSourceFreezeResult,
): Promise<string | null> {
  const artifacts = await workflowData.listWorkflowArtifactsByExecutionId(
    executionId,
  );
  const latest = latestWorkflowArtifact(artifacts, isStrictSourceArtifact);
  return latest &&
    artifactMatchesFreeze(latest, freeze) &&
    verifiedPromotion(latest.metadata?.promotion)
    ? latest.id
    : null;
}

async function findTeardownCheckpoint(
  workflowData: TeardownWorkflowData,
  executionId: string,
  expectedServices: readonly string[],
  expectedFreeze?: DevPreviewSourceFreezeResult,
): Promise<PromotedCheckpoint | null> {
  const artifacts = await workflowData.listWorkflowArtifactsByExecutionId(
    executionId,
  );
  for (const artifact of [...artifacts].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
  )) {
    if (!isStrictSourceArtifact(artifact)) continue;
    const promotion = verifiedPromotion(artifact.metadata?.promotion);
    if (!promotion) continue;
    const marker = record(artifact.metadata?.teardownCheckpoint);
    const services = freezeReceipts(marker?.services);
    const markerFreeze =
      typeof marker?.generation === "string" &&
      GENERATION.test(marker.generation) &&
      services &&
      services.every(({ generation }) => generation === marker.generation)
        ? {
            executionId,
            generation: marker.generation,
            services,
          }
        : null;
    if (
      marker?.version === 2 &&
      marker.executionId === executionId &&
      marker.artifactId === artifact.id &&
      marker.receiptId === promotion.receiptId &&
      marker.centralArtifactId === promotion.centralArtifactId &&
      marker.repository === promotion.repository &&
      marker.pullRequestNumber === promotion.pullRequestNumber &&
      marker.prUrl === promotion.prUrl &&
      marker.branch === promotion.branch &&
      marker.headSha === promotion.headSha &&
      markerFreeze &&
      artifactMatchesFreeze(artifact, markerFreeze) &&
      sameStrings(
        markerFreeze.services.map(({ service }) => service),
        expectedServices,
      ) &&
      (!expectedFreeze ||
        (markerFreeze.generation === expectedFreeze.generation &&
          sameFreezeReceipts(markerFreeze.services, expectedFreeze.services)))
    ) {
      return checkpointFrom(artifact.id, promotion, markerFreeze);
    }
  }
  return null;
}

function checkpointFrom(
  artifactId: string,
  promotion: VerifiedPromotion,
  freeze: DevPreviewSourceFreezeResult,
): PromotedCheckpoint {
  return {
    status: "promoted",
    artifactId,
    receiptId: promotion.receiptId,
    repository: promotion.repository,
    pullRequestNumber: promotion.pullRequestNumber,
    branch: promotion.branch,
    headSha: promotion.headSha,
    generation: freeze.generation,
    services: freeze.services.map((receipt) => ({ ...receipt })),
  };
}

function validFreeze(
  freeze: DevPreviewSourceFreezeResult,
  executionId: string,
  expectedServices: readonly string[],
): boolean {
  const services = freezeReceipts(freeze.services);
  return (
    freeze.executionId === executionId &&
    GENERATION.test(freeze.generation) &&
    services !== null &&
    services.every(({ generation }) => generation === freeze.generation) &&
    JSON.stringify(services.map(({ service }) => service).sort()) ===
      JSON.stringify([...expectedServices].sort())
  );
}

function artifactMatchesFreeze(
  artifact: WorkflowArtifactRecord,
  freeze: DevPreviewSourceFreezeResult,
): boolean {
  const payload = record(artifact.inlinePayload);
  const services = Array.isArray(payload?.services)
    ? payload.services.filter((value): value is string => typeof value === "string")
    : [];
  return (
    payload?.generation === freeze.generation &&
    JSON.stringify([...services].sort()) ===
      JSON.stringify(freeze.services.map(({ service }) => service).sort())
  );
}

function freezeReceipts(value: unknown): DevPreviewSourceFreezeReceipt[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const receipts: DevPreviewSourceFreezeReceipt[] = [];
  for (const item of value) {
    const receipt = record(item);
    if (
      !receipt ||
      typeof receipt.service !== "string" ||
      !SERVICE.test(receipt.service) ||
      typeof receipt.generation !== "string" ||
      !GENERATION.test(receipt.generation) ||
      typeof receipt.contentSha256 !== "string" ||
      !SHA256.test(receipt.contentSha256)
    ) {
      return null;
    }
    receipts.push({
      service: receipt.service,
      generation: receipt.generation,
      contentSha256: receipt.contentSha256 as `sha256:${string}`,
    });
  }
  if (new Set(receipts.map(({ service }) => service)).size !== receipts.length) {
    return null;
  }
  return receipts;
}

function requestedServicesFromExecutionInput(
  input: Record<string, unknown> | null | undefined,
): string[] | null {
  if (!input) return null;
  if (Object.hasOwn(input, "services")) {
    return Array.isArray(input.services) && validExactServiceList(input.services)
      ? [...input.services].sort()
      : null;
  }
  return validExactServiceList([input.service]) ? [input.service as string] : null;
}

function validExactServiceList(values: readonly unknown[]): values is string[] {
  if (values.length === 0) return false;
  const services: string[] = [];
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value !== value.trim() ||
      !SERVICE.test(value)
    ) {
      return false;
    }
    services.push(value);
  }
  return new Set(services).size === services.length;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
  );
}

function sameFreezeReceipts(
  left: readonly DevPreviewSourceFreezeReceipt[],
  right: readonly DevPreviewSourceFreezeReceipt[],
): boolean {
  const normalized = (items: readonly DevPreviewSourceFreezeReceipt[]) =>
    [...items]
      .sort((a, b) => a.service.localeCompare(b.service))
      .map(({ service, generation, contentSha256 }) => ({
        service,
        generation,
        contentSha256,
      }));
  return JSON.stringify(normalized(left)) === JSON.stringify(normalized(right));
}

function isStrictSourceArtifact(
  artifact: WorkflowArtifactRecord | null | undefined,
): artifact is WorkflowArtifactRecord {
  if (!artifact || artifact.kind !== "source-bundle" || !artifact.fileId) {
    return false;
  }
  const payload = record(artifact.inlinePayload);
  return (
    payload?.tier === "tar-overlay-set" &&
    (payload.captureProtocol === "atomic-generation-v2" ||
      payload.acceptanceEligible === true)
  );
}

function verifiedPromotion(value: unknown): VerifiedPromotion | null {
  const promotion = record(value);
  if (!promotion) return null;
  const receiptId = promotion.receiptId;
  const centralArtifactId = promotion.centralArtifactId;
  const repository = promotion.repository;
  const pullRequestNumber = promotion.pullRequestNumber;
  const prUrl = promotion.prUrl;
  const branch = promotion.branch;
  const commitSha = promotion.commitSha;
  const baseSha = promotion.baseSha;
  const headSha = promotion.headSha;
  if (
    typeof receiptId !== "string" ||
    !SAFE_ID.test(receiptId) ||
    typeof centralArtifactId !== "string" ||
    !SAFE_ID.test(centralArtifactId) ||
    typeof repository !== "string" ||
    !REPOSITORY.test(repository) ||
    typeof pullRequestNumber !== "number" ||
    !Number.isSafeInteger(pullRequestNumber) ||
    pullRequestNumber < 1 ||
    typeof prUrl !== "string" ||
    prUrl !== `https://github.com/${repository}/pull/${pullRequestNumber}` ||
    typeof branch !== "string" ||
    !branch.trim() ||
    branch.length > 255 ||
    typeof baseSha !== "string" ||
    !FULL_SHA.test(baseSha) ||
    typeof headSha !== "string" ||
    !FULL_SHA.test(headSha) ||
    headSha === baseSha ||
    commitSha !== headSha ||
    promotion.draft !== true ||
    promotion.mode !== "pr"
  ) {
    return null;
  }
  return {
    receiptId,
    centralArtifactId,
    repository,
    pullRequestNumber,
    prUrl,
    branch: branch.trim(),
    baseSha,
    headSha,
  };
}

function matchesPromotionResponse(
  promotion: VerifiedPromotion,
  response: PreviewSessionContinuationPromotionBody,
): boolean {
  return (
    response.action === "promote" &&
    response.receiptId === promotion.receiptId &&
    response.branch === promotion.branch &&
    response.prUrl === promotion.prUrl &&
    response.pullRequest.repository === promotion.repository &&
    response.pullRequest.number === promotion.pullRequestNumber &&
    response.draft === true
  );
}

function checkpointError(
  executionId: string,
  error: string,
): TeardownErrorResult {
  return productError(executionId, 409, error);
}

function productError(
  executionId: string,
  httpStatus: 403 | 404 | 409 | 503,
  error: string,
): TeardownErrorResult {
  return {
    status: "error",
    httpStatus,
    body: {
      ok: false,
      complete: false,
      pending: false,
      executionId,
      error,
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

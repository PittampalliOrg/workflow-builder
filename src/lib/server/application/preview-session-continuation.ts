import type {
  CaptureDevPreviewSourcesResult,
  DevPreviewAcceptanceCapturePort,
  PreviewAcceptanceBrokerResult,
  PreviewLocalControlIdentityPort,
  PreviewSessionContinuationBody,
  PreviewSessionContinuationInput,
  PreviewSessionContinuationPort,
  PreviewSessionContinuationResult,
  PreviewSourcePromotionAcceptancePort,
  PreviewSourcePromotionPort,
  PreviewSourcePromotionResult,
  WorkflowArtifactRecord,
  WorkflowDataService,
} from "$lib/server/application/ports";
import { latestWorkflowArtifact } from "$lib/server/application/workflow-code-version-order";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

type ContinuationAction =
  | Readonly<{
      kind: "capture";
      services: readonly string[];
      iteration: number | null;
    }>
  | Readonly<{
      kind: "promote";
      artifactId: string;
      title: string | null;
      bodyMarkdown: string | null;
      draft: boolean;
    }>
  | Readonly<{
      kind: "acceptance";
      artifactId: string;
    }>;

type PreviewSessionContinuationDeps = Readonly<{
  workflowData: Pick<
    WorkflowDataService,
    | "getScopedExecutionById"
    | "isPlatformAdmin"
    | "getWorkflowArtifactForExecution"
    | "listWorkflowArtifactsByExecutionId"
    | "mergeWorkflowArtifactMetadata"
  >;
  identity: PreviewLocalControlIdentityPort;
  capture: DevPreviewAcceptanceCapturePort;
  promotion: PreviewSourcePromotionPort;
  acceptance: PreviewSourcePromotionAcceptancePort;
  requestId?: () => string;
  now?: () => Date;
}>;

/**
 * Continues a user-owned interactive preview without turning the public route
 * into a control-plane client. Its immutable identity is always local, never
 * browser supplied.
 */
export class ApplicationPreviewSessionContinuationService
  implements PreviewSessionContinuationPort
{
  private readonly requestId: () => string;

  constructor(private readonly deps: PreviewSessionContinuationDeps) {
    this.requestId = deps.requestId ?? (() => globalThis.crypto.randomUUID());
  }

  async continue(
    input: PreviewSessionContinuationInput,
  ): Promise<PreviewSessionContinuationResult> {
    const action = parseAction(input.action);
    if (!action) return failure(400, "Invalid preview continuation action");

    const execution = await this.deps.workflowData
      .getScopedExecutionById({
        executionId: input.executionId,
        userId: input.userId,
        projectId: input.projectId ?? null,
      })
      .catch(() => null);
    if (!execution) return failure(404, "Execution not found");
    if (
      action.kind !== "capture" &&
      !(await this.deps.workflowData.isPlatformAdmin(input.userId))
    ) {
      return failure(403, "Admin access required");
    }

    let identity;
    try {
      identity = this.deps.identity.current();
    } catch {
      return failure(502, "Preview continuation is unavailable");
    }

    try {
      switch (action.kind) {
        case "capture":
          {
            const result = await this.deps.capture.captureAcceptanceCandidate({
                executionId: execution.id,
                nodeId: "preview-session-continuation",
                iteration: action.iteration,
                expectedServices: action.services,
                platformRevision: identity.environmentPlatformRevision,
                sourceRevision: identity.environmentSourceRevision,
                catalogDigest: identity.catalogDigest,
              });
            return success(captureBody(result), result.ok ? 200 : 422);
          }
        case "promote": {
          const checkpoint = await this.currentStrictSourceArtifact(
            execution.id,
            action.artifactId,
          );
          if (checkpoint.status === "not_found") {
            return failure(404, "Source checkpoint not found");
          }
          if (checkpoint.status !== "ok") {
            return failure(409, checkpoint.message);
          }
          const result = await this.deps.promotion.promote({
            executionId: execution.id,
            artifactId: action.artifactId,
            title: action.title,
            bodyMarkdown: action.bodyMarkdown,
            draft: action.draft,
          });
          // Promotion transfers the preview-local artifact before it reaches
          // the hub. The result therefore carries the new central artifact ID,
          // not the browser-supplied preview-local source ID.
          if (result.executionId !== execution.id) {
            throw new Error("preview promotion result is not scoped to the execution");
          }
          const promotion = promotionReceipt(
            result,
            input.userId,
            this.deps.now?.() ?? new Date(),
          );
          const updated = await this.deps.workflowData.mergeWorkflowArtifactMetadata({
            executionId: execution.id,
            artifactId: action.artifactId,
            patch: { promotion },
          });
          if (!updated) {
            throw new Error("preview promotion receipt could not be persisted");
          }
          return success(promotionBody(result, action.artifactId));
        }
        case "acceptance": {
          const checkpoint = await this.currentStrictSourceArtifact(
            execution.id,
            action.artifactId,
          );
          if (checkpoint.status !== "ok") {
            return failure(
              409,
              checkpoint.status === "not_found"
                ? "Source checkpoint has no verified promotion receipt"
                : checkpoint.message,
            );
          }
          const sourceArtifact = checkpoint.artifact;
          const promotion = sourceArtifact
            ? storedPromotion(sourceArtifact.metadata?.promotion)
            : null;
          if (!sourceArtifact || !promotion) {
            return failure(409, "Source checkpoint has no verified promotion receipt");
          }
          const result = await this.deps.acceptance.replay({
            requestId: this.requestId(),
            previewName: identity.previewName,
            environmentRequestId: identity.environmentRequestId,
            environmentPlatformRevision: identity.environmentPlatformRevision,
            environmentSourceRevision: identity.environmentSourceRevision,
            catalogDigest: identity.catalogDigest,
            executionId: execution.id,
            receiptId: promotion.receiptId,
          });
          if (!matchesAcceptance(result, promotion, identity.previewName)) {
            throw new Error("preview acceptance result does not match its request");
          }
          const updated = await this.deps.workflowData.mergeWorkflowArtifactMetadata({
            executionId: execution.id,
            artifactId: action.artifactId,
            patch: {
              acceptance: {
                receiptId: promotion.receiptId,
                baseSha: result.pullRequest.baseSha,
                headSha: result.pullRequest.headSha,
                ok: result.ok === true,
                services: [...result.services],
                ...(result.evidenceReceiptDigest
                  ? { evidenceReceiptDigest: result.evidenceReceiptDigest }
                  : {}),
                ...(result.stage ? { stage: result.stage } : {}),
                ...(result.message ? { message: result.message } : {}),
                ...(result.verification
                  ? { verification: copyVerification(result.verification) }
                  : {}),
                ...(result.cleanup !== undefined
                  ? { cleanup: copyCleanup(result.cleanup) }
                  : {}),
                completedAt: (this.deps.now?.() ?? new Date()).toISOString(),
              },
            },
          });
          if (!updated) {
            throw new Error("preview acceptance receipt could not be persisted");
          }
          return success(acceptanceBody(result), result.ok ? 200 : 422);
        }
      }
    } catch {
      // The public API preserves validated outcome evidence, not transport
      // failures or privileged control-plane provenance.
      return failure(502, "Preview continuation could not complete");
    }
  }

  private async currentStrictSourceArtifact(
    executionId: string,
    artifactId: string,
  ): Promise<
    | Readonly<{ status: "ok"; artifact: WorkflowArtifactRecord }>
    | Readonly<{ status: "not_found" }>
    | Readonly<{ status: "invalid"; message: string }>
  > {
    const artifact = await this.deps.workflowData.getWorkflowArtifactForExecution({
      executionId,
      artifactId,
    });
    if (artifact?.kind !== "source-bundle" || !artifact.fileId) {
      return { status: "not_found" };
    }
    if (!isStrictAtomicSnapshot(artifact.inlinePayload)) {
      return {
        status: "invalid",
        message: "Only strict source checkpoints can use preview continuation",
      };
    }

    const artifacts =
      await this.deps.workflowData.listWorkflowArtifactsByExecutionId(executionId);
    const latest = latestWorkflowArtifact(
      artifacts,
      (candidate) =>
        candidate.kind === "source-bundle" &&
        isStrictAtomicSnapshot(candidate.inlinePayload),
    );
    if (!latest || latest.id !== artifact.id) {
      return {
        status: "invalid",
        message: "Historical source checkpoints are read-only",
      };
    }
    return { status: "ok", artifact };
  }
}

function isStrictAtomicSnapshot(value: unknown): boolean {
  const payload = record(value);
  return (
    payload?.tier === "tar-overlay-set" &&
    (payload.captureProtocol === "atomic-generation-v2" ||
      payload.acceptanceEligible === true)
  );
}

function parseAction(value: unknown): ContinuationAction | null {
  const body = record(value);
  if (!body || typeof body.action !== "string") return null;

  if (body.action === "capture" && onlyKeys(body, ["action", "services", "iteration"])) {
    const services = stringList(body.services);
    const iteration = body.iteration;
    if (
      services &&
      (iteration === undefined ||
        (typeof iteration === "number" &&
          Number.isSafeInteger(iteration) &&
          iteration >= 0))
    ) {
      return {
        kind: "capture",
        services,
        iteration: typeof iteration === "number" ? iteration : null,
      };
    }
  }

  if (
    body.action === "promote" &&
    onlyKeys(body, ["action", "artifactId", "title", "bodyMarkdown", "draft"]) &&
    nonBlankString(body.artifactId) &&
    optionalString(body.title) &&
    optionalString(body.bodyMarkdown) &&
    (body.draft === undefined || body.draft === true)
  ) {
    return {
      kind: "promote",
      artifactId: body.artifactId.trim(),
      title: optionalText(body.title),
      bodyMarkdown: optionalText(body.bodyMarkdown),
      draft: true,
    };
  }

  if (
    body.action === "acceptance" &&
    onlyKeys(body, ["action", "artifactId"]) &&
    nonBlankString(body.artifactId) &&
    SAFE_ID.test(body.artifactId.trim())
  ) {
      return {
        kind: "acceptance",
        artifactId: body.artifactId.trim(),
      };
  }

  return null;
}

function captureBody(
  result: CaptureDevPreviewSourcesResult,
): PreviewSessionContinuationBody {
  return {
    action: "capture",
    ok: result.ok === true,
    ...(typeof result.artifactId === "string"
      ? { artifactId: result.artifactId }
      : {}),
    ...(typeof result.bytes === "number" ? { bytes: result.bytes } : {}),
    ...(typeof result.captureId === "string"
      ? { captureId: result.captureId }
      : {}),
    ...(result.generation !== undefined
      ? { generation: result.generation }
      : {}),
    ...(result.reused === true ? { reused: true } : {}),
    ...(typeof result.skipped === "string" ? { skipped: result.skipped } : {}),
    services: result.services.map(({ service, ok, skipped }) => ({
      service,
      ok: ok === true,
      ...(typeof skipped === "string" ? { skipped } : {}),
    })),
  };
}

function promotionBody(
  result: PreviewSourcePromotionResult,
  sourceArtifactId: string,
): PreviewSessionContinuationBody {
  return {
    action: "promote",
    ok: true,
    artifactId: sourceArtifactId,
    receiptId: result.receiptId,
    services: [...result.services],
    branch: result.branch,
    prUrl: result.prUrl,
    pullRequest: {
      repository: result.pullRequest.repository,
      number: result.pullRequest.number,
    },
    draft: result.draft === true,
  };
}

function matchesAcceptance(
  result: PreviewAcceptanceBrokerResult,
  promotion: StoredPromotion,
  previewName: string,
): boolean {
  return (
    result.previewName === previewName &&
    result.pullRequest.repository === promotion.repository &&
    result.pullRequest.number === promotion.pullRequestNumber &&
    FULL_SHA.test(result.pullRequest.baseSha) &&
    result.pullRequest.headSha === promotion.headSha &&
    result.pullRequest.baseSha !== result.pullRequest.headSha
  );
}

type StoredPromotion = Readonly<{
  receiptId: string;
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
}>;

function storedPromotion(value: unknown): StoredPromotion | null {
  const item = record(value);
  if (
    !item ||
    typeof item.receiptId !== "string" ||
    !SAFE_ID.test(item.receiptId) ||
    !nonBlankString(item.repository) ||
    typeof item.pullRequestNumber !== "number" ||
    !Number.isSafeInteger(item.pullRequestNumber) ||
    item.pullRequestNumber <= 0 ||
    typeof item.baseSha !== "string" ||
    !FULL_SHA.test(item.baseSha) ||
    typeof item.headSha !== "string" ||
    !FULL_SHA.test(item.headSha) ||
    item.baseSha === item.headSha
  ) {
    return null;
  }
  return {
    receiptId: item.receiptId,
    repository: item.repository.trim(),
    pullRequestNumber: item.pullRequestNumber,
    baseSha: item.baseSha,
    headSha: item.headSha,
  };
}

function promotionReceipt(
  result: PreviewSourcePromotionResult,
  promotedBy: string,
  promotedAt: Date,
): Record<string, unknown> {
  return {
    receiptId: result.receiptId,
    centralArtifactId: result.artifactId,
    prUrl: result.prUrl,
    branch: result.branch,
    commitSha: result.commitSha,
    repository: result.pullRequest.repository,
    pullRequestNumber: result.pullRequest.number,
    baseSha: result.pullRequest.baseSha,
    headSha: result.pullRequest.headSha,
    draft: result.draft,
    services: [...result.services],
    mode: "pr",
    promotedAt: promotedAt.toISOString(),
    promotedBy,
  };
}

function acceptanceBody(
  result: PreviewAcceptanceBrokerResult,
): PreviewSessionContinuationBody {
  return {
    action: "acceptance",
    ok: result.ok === true,
    services: [...result.services],
    pullRequest: {
      repository: result.pullRequest.repository,
      number: result.pullRequest.number,
    },
    ...(result.stage ? { stage: result.stage } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.evidenceReceiptDigest
      ? { evidenceReceiptDigest: result.evidenceReceiptDigest }
      : {}),
    ...(result.verification
      ? { verification: copyVerification(result.verification) }
      : {}),
    ...(result.cleanup !== undefined
      ? { cleanup: copyCleanup(result.cleanup) }
      : {}),
  };
}

function copyVerification(
  verification: NonNullable<PreviewAcceptanceBrokerResult["verification"]>,
) {
  return {
    ok: verification.ok,
    checks: verification.checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      ...(check.detail !== undefined ? { detail: check.detail } : {}),
    })),
  };
}

function copyCleanup(cleanup: PreviewAcceptanceBrokerResult["cleanup"]) {
  return cleanup === null || cleanup === undefined
    ? null
    : {
        name: cleanup.name,
        resourceName: cleanup.resourceName,
        complete: cleanup.complete,
        phase: cleanup.phase,
        checks: { ...cleanup.checks },
        message: cleanup.message,
      };
}

function success(
  body: PreviewSessionContinuationBody,
  httpStatus: 200 | 422 = 200,
): PreviewSessionContinuationResult {
  return { status: "ok", httpStatus, body };
}

function failure(
  httpStatus: 400 | 403 | 404 | 409 | 502,
  message: string,
): PreviewSessionContinuationResult {
  return { status: "error", httpStatus, message };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function stringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const services = value.map((item) =>
    typeof item === "string" ? item.trim() : "",
  );
  return services.every(Boolean) && new Set(services).size === services.length
    ? services
    : null;
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

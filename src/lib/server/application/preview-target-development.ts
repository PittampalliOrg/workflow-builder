import { createHash } from "node:crypto";
import type {
  PreviewControlAdminAuthorizationPort,
  PreviewControlCapabilityMintPort,
  PreviewControlIdentity,
  PreviewControlSourceAuthorityPort,
  PreviewDeploymentScopePort,
  ImmutableGitSha,
  PreviewDevelopmentBrokerSignalInput,
  PreviewDevelopmentBrokerStartInput,
  PreviewDevelopmentBrokerStatusInput,
  PreviewDevelopmentBrokerVerifyPromotionInput,
  PreviewDevelopmentControlAction,
  PreviewDevelopmentPromotionVerificationResult,
  PreviewDevelopmentSignalResult,
  PreviewDevelopmentStartResult,
  PreviewDevelopmentStatusResult,
  PreviewDevelopmentTarget,
  PreviewDevelopmentTerminalOutput,
  PreviewDevelopmentWorkflowInput,
  PreviewDevelopmentWorkflowReceipt,
  PreviewLocalControlIdentityPort,
  PreviewSourcePromotionReceipt,
  PreviewSourcePromotionReceiptStorePort,
  PreviewTargetDevelopmentBrokerPort,
  PreviewTargetDevelopmentLeafTransportPort,
  PreviewTargetDevelopmentLocalPort,
  PreviewTargetDevelopmentPort,
  VclusterPreviewGatewayPort,
  WorkflowApprovalEventPort,
  WorkflowDefinitionRepository,
  WorkflowExecutionRepository,
  WorkflowRunStarterPort,
  WorkspaceProjectRepository,
} from "$lib/server/application/ports";
import {
	PREVIEW_DEVELOPMENT_BUILDER_PROFILES,
  PREVIEW_DEVELOPMENT_WORKFLOW_ID,
  PREVIEW_DEVELOPMENT_WORKFLOW_NAME,
} from "$lib/server/application/ports";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";
import { previewDevelopmentParentBindingPrefix } from "$lib/server/application/preview-development-environment";
import { workflowSpecDigest } from "$lib/server/application/workflow-spec-digest";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_PROGRESS_LABEL = /^[\x20-\x7e]{1,64}$/;
const SAFE_SERVICE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_TARGET_ROUTE = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/;
const SPEC_DIGEST = /^sha256:[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const RECEIPT_ID = /^pspr_[0-9a-f]{64}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const OPERATION_ID =
  /^pdt-(start-workflow|get-workflow-status|signal-workflow|verify-promotion)-[0-9a-f]{64}$/;
const MAX_INTENT_CHARS = 12_000;
const MAX_SERVICES = 16;
const MAX_DIFF_SCOPE_PREFIXES = 128;
const MAX_DIFF_SCOPE_PREFIX_CHARS = 512;
const MAX_TARGET_ROUTES = 16;
// Services that can never be driven by a preview development run because they
// are not preview-native adoptable (catalog previewNative is null). Rejecting
// them here yields a precise error instead of a dead-end deeper in the runner.
const EXCLUDED_SERVICES: ReadonlySet<string> = new Set(["swebench-coordinator"]);
const CONTEXT_KEY = "__previewDevelopment";
const SOURCE_REPOSITORY = "PittampalliOrg/workflow-builder" as const;
const SOURCE_BASE_BRANCH = "main" as const;

type OperationKind =
  | "start-workflow"
  | "get-workflow-status"
  | "signal-workflow"
  | "verify-promotion";

export type PreviewTargetDevelopmentErrorCode =
  | "invalid-request"
  | "not-found"
  | "not-ready"
  | "unauthorized"
  | "contract-mismatch"
  | "upstream-failure";

export class PreviewTargetDevelopmentError extends Error {
  constructor(
    public readonly code: PreviewTargetDevelopmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreviewTargetDevelopmentError";
  }
}

function invalid(message: string): never {
  throw new PreviewTargetDevelopmentError("invalid-request", message);
}

function asIdentity(target: PreviewDevelopmentTarget): PreviewControlIdentity {
  try {
    return validatePreviewControlIdentity({
      previewName: target.previewName,
      environmentRequestId: target.environmentRequestId,
      environmentPlatformRevision: target.platformRevision,
      environmentSourceRevision: target.sourceRevision,
      catalogDigest: target.catalogDigest,
    });
  } catch {
    return invalid("preview development target is invalid");
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

function targetFromIdentity(
  identity: PreviewControlIdentity,
): PreviewDevelopmentTarget {
  return Object.freeze({
    previewName: identity.previewName,
    environmentRequestId: identity.environmentRequestId,
    platformRevision: identity.environmentPlatformRevision,
    sourceRevision: identity.environmentSourceRevision,
    catalogDigest: identity.catalogDigest,
  });
}

function validateOperationId(operationId: string, kind: OperationKind): string {
  if (
    !OPERATION_ID.test(operationId) ||
    !operationId.startsWith(`pdt-${kind}-`)
  ) {
    return invalid(`invalid ${kind} operation id`);
  }
  return operationId;
}

function validateWorkflowReceipt(
  workflow: PreviewDevelopmentWorkflowReceipt,
): PreviewDevelopmentWorkflowReceipt {
  if (
    workflow.workflowName !== PREVIEW_DEVELOPMENT_WORKFLOW_NAME ||
    !SAFE_ID.test(workflow.executionId) ||
    !SPEC_DIGEST.test(workflow.workflowSpecDigest)
  ) {
    return invalid("preview development workflow receipt is invalid");
  }
  return workflow;
}

function validatePromotionCoordinates(input: {
  childExecutionId: string;
  receiptId: string;
}): void {
  if (
    !SAFE_ID.test(input.childExecutionId) ||
    !RECEIPT_ID.test(input.receiptId)
  ) {
    return invalid("preview development promotion coordinates are invalid");
  }
}

function normalizePromotionServices(
  services: readonly string[],
): readonly string[] {
  if (
    !Array.isArray(services) ||
    services.length < 1 ||
    services.length > MAX_SERVICES ||
    services.some(
      (service) => typeof service !== "string" || !SAFE_SERVICE.test(service),
    ) ||
    new Set(services).size !== services.length
  ) {
    return invalid("preview development promotion services are invalid");
  }
  return Object.freeze([...services]);
}

function promotionBranch(input: {
  target: PreviewDevelopmentTarget;
  executionId: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        input.target.previewName,
        input.target.environmentRequestId,
        input.executionId,
        input.target.platformRevision,
        input.target.sourceRevision,
        input.target.catalogDigest,
        SOURCE_REPOSITORY,
        SOURCE_BASE_BRANCH,
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 32);
  return `preview-feature-${digest}`;
}

function validBranch(branch: string): boolean {
  return (
    SAFE_BRANCH.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !branch.endsWith(".") &&
    !branch.endsWith(".lock")
  );
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function servicesAuthorized(
  requested: readonly string[],
  authorized: readonly string[],
): boolean {
  return (
    requested.length > 0 &&
    new Set(requested).size === requested.length &&
    requested.every(
      (value) => SAFE_SERVICE.test(value) && authorized.includes(value),
    )
  );
}

function canonicalPromotionVerification(
  input: PreviewDevelopmentBrokerVerifyPromotionInput,
  receipt: PreviewSourcePromotionReceipt,
  authorizedServices: readonly string[],
): PreviewDevelopmentPromotionVerificationResult {
  const expectedPrUrl = `https://github.com/${SOURCE_REPOSITORY}/pull/${receipt.pullRequestNumber}`;
  if (
    receipt.receiptId !== input.receiptId ||
    receipt.previewName !== input.target.previewName ||
    receipt.requestId !== input.target.environmentRequestId ||
    receipt.executionId !== input.childExecutionId ||
    receipt.platformRevision !== input.target.platformRevision ||
    receipt.sourceRevision !== input.target.sourceRevision ||
    receipt.catalogDigest !== input.target.catalogDigest ||
    receipt.repository !== SOURCE_REPOSITORY ||
    receipt.baseBranch !== SOURCE_BASE_BRANCH ||
    receipt.draft !== true ||
    !sameStringSet(receipt.services, input.services) ||
    !servicesAuthorized(input.services, authorizedServices) ||
    !FULL_SHA.test(receipt.baseSha) ||
    !FULL_SHA.test(receipt.commitSha) ||
    receipt.baseSha === receipt.commitSha ||
    !validBranch(receipt.branch) ||
    receipt.branch !==
      promotionBranch({
        target: input.target,
        executionId: input.childExecutionId,
      }) ||
    !Number.isSafeInteger(receipt.pullRequestNumber) ||
    receipt.pullRequestNumber < 1 ||
    receipt.prUrl !== expectedPrUrl
  ) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "promotion receipt does not match the exact preview development contract",
    );
  }
  return Object.freeze({
    kind: "verify-promotion" as const,
    operationId: input.operationId,
    target: input.target,
    executionId: input.childExecutionId,
    verified: true as const,
    receipt: Object.freeze({
      ok: true as const,
      receiptId: receipt.receiptId,
      previewName: receipt.previewName,
      requestId: receipt.requestId,
      executionId: receipt.executionId,
      artifactId: receipt.artifactId,
      services: Object.freeze([...receipt.services].sort()),
      branch: receipt.branch,
      commitSha: receipt.commitSha,
      prUrl: receipt.prUrl,
      pullRequest: Object.freeze({
        repository: SOURCE_REPOSITORY,
        number: receipt.pullRequestNumber,
        baseSha: receipt.baseSha,
        headSha: receipt.commitSha,
      }),
      draft: true as const,
    }),
  });
}

function normalizeWorkflowInput(
  input: PreviewDevelopmentWorkflowInput,
): PreviewDevelopmentWorkflowInput {
  if (
    typeof input.intent !== "string" ||
    input.intent.length > MAX_INTENT_CHARS ||
    /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.intent) ||
    !Array.isArray(input.services) ||
    input.services.length < 1 ||
    input.services.length > MAX_SERVICES ||
    input.services.some(
      (service) => typeof service !== "string" || !SAFE_SERVICE.test(service),
    ) ||
    (input.builderProfile !== undefined &&
      !PREVIEW_DEVELOPMENT_BUILDER_PROFILES.includes(input.builderProfile)) ||
    new Set(input.services).size !== input.services.length
  ) {
    return invalid("preview development workflow input is invalid");
  }
  // swebench-coordinator (and any other non-adoptable service) can never be
  // driven by a preview development run; reject it before dispatching anything.
  const excluded = input.services.find((service) =>
    EXCLUDED_SERVICES.has(service),
  );
  if (excluded !== undefined) {
    return invalid(
      `preview development does not support ${excluded} (not preview-native adoptable)`,
    );
  }
  // The pinned child now seeds every requested service's sync config into the
  // workspace (.syncenv.d/<service>) and drives one shared sync.sh generation,
  // so multi-service is supported when explicitly enabled. It stays OFF by
  // default so the proven single-service flow is byte-for-byte unchanged; the
  // PREVIEW_DEV_MULTISERVICE env flag is the single opt-in switch. MAX_SERVICES
  // is enforced above regardless of the flag.
  const multiServiceEnabled = process.env.PREVIEW_DEV_MULTISERVICE === "true";
  if (!multiServiceEnabled && input.services.length > 1) {
    return invalid(
      `multi-service preview development is not yet supported: only 1 service may be requested (got ${input.services.length})`,
    );
  }
  if (
    input.targetRoutes !== undefined &&
    (!Array.isArray(input.targetRoutes) ||
      input.targetRoutes.length < 1 ||
      input.targetRoutes.length > MAX_TARGET_ROUTES ||
      input.targetRoutes.some(
        (route) => typeof route !== "string" || !SAFE_TARGET_ROUTE.test(route),
      ) ||
      new Set(input.targetRoutes).size !== input.targetRoutes.length)
  ) {
    return invalid("targetRoutes must contain unique absolute application routes");
  }
  if (
    input.keepPreview !== undefined &&
    typeof input.keepPreview !== "boolean" &&
    input.keepPreview !== "true" &&
    input.keepPreview !== "false"
  ) {
    return invalid("keepPreview must be a boolean");
  }
  if (
    input.ttlHours !== undefined &&
    (!Number.isInteger(input.ttlHours) ||
      input.ttlHours < 2 ||
      input.ttlHours > 24)
  ) {
    return invalid("ttlHours must be an integer between 2 and 24");
  }
  for (const [key, value] of [
    ["retainAfterCompletion", input.retainAfterCompletion],
    ["interactiveHandoff", input.interactiveHandoff],
    ["impactReview", input.impactReview],
  ] as const) {
    if (
      value !== undefined &&
      typeof value !== "boolean" &&
      value !== "true" &&
      value !== "false"
    ) {
      return invalid(`${key} must be a boolean`);
    }
  }
  if (
    input.diffScope !== undefined &&
    (!Array.isArray(input.diffScope) ||
      input.diffScope.length > MAX_DIFF_SCOPE_PREFIXES ||
      input.diffScope.some(
        (prefix) =>
          typeof prefix !== "string" ||
          prefix.trim().length < 1 ||
          prefix.length > MAX_DIFF_SCOPE_PREFIX_CHARS ||
          /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prefix),
      ))
  ) {
    return invalid("diffScope must contain valid path prefixes");
  }
  if (
    input.maxIterations !== undefined &&
    (!Number.isInteger(input.maxIterations) ||
      input.maxIterations < 1 ||
      input.maxIterations > 3)
  ) {
    return invalid("maxIterations must be an integer between 1 and 3");
  }
  return Object.freeze({
    intent: input.intent,
    services: Object.freeze([...input.services]),
    ...(input.builderProfile !== undefined
      ? { builderProfile: input.builderProfile }
      : {}),
    ...(input.targetRoutes !== undefined
      ? { targetRoutes: Object.freeze([...input.targetRoutes]) }
      : {}),
    ...(input.keepPreview !== undefined
      ? {
          keepPreview:
            input.keepPreview === true || input.keepPreview === "true"
              ? "true"
              : "false",
        }
      : {}),
    // Optional child controls pass through verbatim. The child fixture owns
    // their behavior; absent fields preserve the established start payload.
    ...(input.ttlHours !== undefined ? { ttlHours: input.ttlHours } : {}),
    ...(input.retainAfterCompletion !== undefined
      ? { retainAfterCompletion: input.retainAfterCompletion }
      : {}),
    ...(input.interactiveHandoff !== undefined
      ? { interactiveHandoff: input.interactiveHandoff }
      : {}),
    ...(input.impactReview !== undefined
      ? { impactReview: input.impactReview }
      : {}),
    ...(input.diffScope !== undefined
      ? { diffScope: Object.freeze([...input.diffScope]) }
      : {}),
    ...(input.maxIterations !== undefined
      ? { maxIterations: input.maxIterations }
      : {}),
  });
}

function childExecutionId(input: {
  parentExecutionId: string;
  target: PreviewDevelopmentTarget;
  workflowSpecDigest: string;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        "preview-development-child/v2",
        input.parentExecutionId,
        input.target.previewName,
        input.target.environmentRequestId,
        input.target.platformRevision,
        input.target.sourceRevision,
        input.target.catalogDigest,
        input.workflowSpecDigest,
        "",
      ].join("\0"),
      "utf8",
    )
    .digest("hex");
  return `pdc_${digest.slice(0, 60)}`;
}

function activeParentStatus(status: string): boolean {
  return status === "pending" || status === "running";
}

function terminalExecutionStatus(status: string): boolean {
  return status === "success" || status === "error" || status === "cancelled";
}

function outputControlAction(
  output: unknown,
): PreviewDevelopmentControlAction | null {
  if (!output || typeof output !== "object" || Array.isArray(output))
    return null;
  const action = (output as Record<string, unknown>).controlAction;
  return action === "submit_preview_pr" || action === "discard" ? action : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalStatusOutput(input: {
  status: string;
  output: unknown;
  target: PreviewDevelopmentTarget;
  executionId: string;
}): PreviewDevelopmentTerminalOutput | null {
  if (input.status !== "success") return null;
  const output = terminalOutputPayload(input.output);
  const controlOutcome = output?.controlOutcome;
  if (
    controlOutcome !== "submitted" &&
    controlOutcome !== "discarded" &&
    controlOutcome !== "timed_out" &&
    controlOutcome !== "invalid_control" &&
    controlOutcome !== "snapshot_failed" &&
    controlOutcome !== "promotion_failed"
  ) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "preview development child returned an invalid terminal outcome",
    );
  }
  if (controlOutcome !== "submitted") {
    return Object.freeze({ controlOutcome, pullRequestReceipt: null });
  }

  const receipt = record(output?.pullRequestReceipt);
  const pullRequest = record(receipt?.pullRequest);
  const services = receipt?.services;
  const pullRequestNumber = pullRequest?.number;
  const expectedPrUrl = `https://github.com/${SOURCE_REPOSITORY}/pull/${String(pullRequestNumber ?? "")}`;
  if (
    receipt?.ok !== true ||
    typeof receipt.receiptId !== "string" ||
    !RECEIPT_ID.test(receipt.receiptId) ||
    receipt.previewName !== input.target.previewName ||
    receipt.requestId !== input.target.environmentRequestId ||
    receipt.executionId !== input.executionId ||
    !Array.isArray(services) ||
    services.length < 1 ||
    services.length > MAX_SERVICES ||
    services.some(
      (service) => typeof service !== "string" || !SAFE_SERVICE.test(service),
    ) ||
    new Set(services).size !== services.length ||
    typeof receipt.branch !== "string" ||
    !validBranch(receipt.branch) ||
    receipt.branch !==
      promotionBranch({
        target: input.target,
        executionId: input.executionId,
      }) ||
    typeof receipt.commitSha !== "string" ||
    !FULL_SHA.test(receipt.commitSha) ||
    receipt.draft !== true ||
    pullRequest?.repository !== SOURCE_REPOSITORY ||
    !Number.isSafeInteger(pullRequestNumber) ||
    (pullRequestNumber as number) < 1 ||
    typeof pullRequest?.baseSha !== "string" ||
    !FULL_SHA.test(pullRequest.baseSha) ||
    typeof pullRequest?.headSha !== "string" ||
    pullRequest.headSha !== receipt.commitSha ||
    pullRequest.baseSha === pullRequest.headSha ||
    receipt.prUrl !== expectedPrUrl
  ) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "preview development child returned an invalid draft pull request receipt",
    );
  }
  return Object.freeze({
    controlOutcome,
    pullRequestReceipt: Object.freeze({
      ok: true as const,
      receiptId: receipt.receiptId,
      previewName: input.target.previewName,
      requestId: input.target.environmentRequestId,
      executionId: input.executionId,
      services: Object.freeze([...services].sort()) as readonly string[],
      branch: receipt.branch,
      commitSha: receipt.commitSha,
      prUrl: expectedPrUrl,
      pullRequest: Object.freeze({
        repository: SOURCE_REPOSITORY,
        number: pullRequestNumber as number,
        baseSha: pullRequest.baseSha,
        headSha: pullRequest.headSha,
      }),
      draft: true as const,
    }),
  });
}

function terminalOutputPayload(
  output: unknown,
): Record<string, unknown> | null {
  const direct = record(output);
  if (!direct) return null;
  if (typeof direct.controlOutcome === "string") return direct;

  const returnValue = record(direct.returnValue);
  if (typeof returnValue?.controlOutcome === "string") return returnValue;

  const workflowOutput = record(direct.workflowOutput);
  if (typeof workflowOutput?.controlOutcome === "string") return workflowOutput;

  const outputs = record(direct.outputs);
  const state = record(outputs?.state);
  const stateData = record(state?.data);
  const nestedData = record(stateData?.data);

  if (typeof nestedData?.controlOutcome === "string") return nestedData;
  if (typeof stateData?.controlOutcome === "string") return stateData;
  return direct;
}

function previewLaunchOrigin(scope: PreviewDeploymentScopePort): string {
  const deployment = scope.current();
  if (
    deployment.kind !== "preview" ||
    deployment.preview.profile !== "app-live"
  ) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "preview-local development commands require an app-live deployment",
    );
  }
  let origin: URL;
  try {
    origin = new URL(deployment.preview.origin ?? "");
  } catch {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "preview deployment has no canonical origin",
    );
  }
  const labels = origin.hostname.split(".");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.port ||
    labels.length < 4 ||
    labels.at(-2) !== "ts" ||
    labels.at(-1) !== "net"
  ) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "preview deployment origin is outside the trusted HTTPS tailnet",
    );
  }
  return `https://wfb-${deployment.preview.name}.${labels.slice(1).join(".")}`;
}

function validSessionLink(
  result: PreviewDevelopmentStatusResult,
  target: PreviewDevelopmentTarget,
  expectedOrigin: string,
): boolean {
  if (result.sessionId === null || result.sessionUrl === null) {
    return (
      result.sessionId === null &&
      result.sessionUrl === null &&
      result.controlReady === false
    );
  }
  if (!SAFE_ID.test(result.sessionId)) return false;
  try {
    const url = new URL(result.sessionUrl);
    const path = url.pathname.split("/");
    const workspace = decodeURIComponent(path[2] ?? "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.search &&
      !url.hash &&
      url.origin === expectedOrigin &&
      url.hostname.startsWith(`wfb-${target.previewName}.`) &&
      url.hostname.endsWith(".ts.net") &&
      path.length === 5 &&
      path[0] === "" &&
      path[1] === "workspaces" &&
      SAFE_ID.test(workspace) &&
      path[2] === encodeURIComponent(workspace) &&
      path[3] === "sessions" &&
      path[4] === encodeURIComponent(result.sessionId)
    );
  } catch {
    return false;
  }
}

function remoteResultRecord(
  result: unknown,
  input: PreviewDevelopmentBrokerStatusInput,
  kind: OperationKind,
): Record<string, unknown> {
  const value = record(result);
  const remoteTarget = record(value?.target);
  const mismatches = remoteResultMismatches(value, remoteTarget, input, kind);
  if (mismatches.length > 0) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      `preview-local response does not match the dispatched command: ${mismatches.join(", ")}`,
    );
  }
  return value!;
}

function remoteResultMismatches(
  value: Record<string, unknown> | null,
  remoteTarget: Record<string, unknown> | null,
  input: PreviewDevelopmentBrokerStatusInput,
  kind: OperationKind,
): string[] {
  if (!value) return ["response"];
  const mismatches: string[] = [];
  if (value.kind !== kind) mismatches.push("kind");
  if (value.operationId !== input.operationId) mismatches.push("operationId");
  if (!remoteTarget) {
    mismatches.push("target");
  } else {
    if (remoteTarget.previewName !== input.target.previewName) {
      mismatches.push("target.previewName");
    }
    if (remoteTarget.environmentRequestId !== input.target.environmentRequestId) {
      mismatches.push("target.environmentRequestId");
    }
    if (remoteTarget.platformRevision !== input.target.platformRevision) {
      mismatches.push("target.platformRevision");
    }
    if (remoteTarget.sourceRevision !== input.target.sourceRevision) {
      mismatches.push("target.sourceRevision");
    }
    if (remoteTarget.catalogDigest !== input.target.catalogDigest) {
      mismatches.push("target.catalogDigest");
    }
  }
  if (value.executionId !== input.workflow.executionId) {
    mismatches.push("executionId");
  }
  if (value.workflowName !== input.workflow.workflowName) {
    mismatches.push("workflowName");
  }
  if (value.workflowSpecDigest !== input.workflow.workflowSpecDigest) {
    mismatches.push("workflowSpecDigest");
  }
  return mismatches;
}

function canonicalRemoteStartResult(
  result: unknown,
  input: PreviewDevelopmentBrokerStartInput,
): PreviewDevelopmentStartResult {
  const value = remoteResultRecord(result, input, "start-workflow");
  if (
    value.status !== "running" ||
    typeof value.reused !== "boolean" ||
    !(
      value.instanceId === null ||
      (typeof value.instanceId === "string" && SAFE_ID.test(value.instanceId))
    )
  ) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "preview-local start returned an invalid workflow state",
    );
  }
  return Object.freeze({
    kind: "start-workflow" as const,
    operationId: input.operationId,
    target: input.target,
    ...input.workflow,
    instanceId: value.instanceId as string | null,
    status: "running" as const,
    reused: value.reused,
  });
}

function safeRemoteProgressLabel(value: unknown): string | null {
  if (
    value === null ||
    (typeof value === "string" && SAFE_PROGRESS_LABEL.test(value))
  ) {
    return value as string | null;
  }
  throw new PreviewTargetDevelopmentError(
    "contract-mismatch",
    "preview-local status returned an invalid progress label",
  );
}

function safeRemoteNodeId(value: unknown): string | null {
  if (value === null || (typeof value === "string" && SAFE_ID.test(value))) {
    return value as string | null;
  }
  throw new PreviewTargetDevelopmentError(
    "contract-mismatch",
    "preview-local status returned an invalid current node id",
  );
}

function canonicalRemoteStatusResult(
  result: unknown,
  input: PreviewDevelopmentBrokerStatusInput,
  expectedOrigin: string,
): PreviewDevelopmentStatusResult {
  const value = remoteResultRecord(result, input, "get-workflow-status");
  const status = value.status;
  if (
    status !== "pending" &&
    status !== "running" &&
    status !== "success" &&
    status !== "error" &&
    status !== "cancelled"
  ) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "preview-local status returned an invalid workflow state",
    );
  }
  const terminal = terminalExecutionStatus(status);
  const progress = value.progress;
  if (
    typeof value.controlReady !== "boolean" ||
    value.terminal !== terminal ||
    !(
      progress === null ||
      (typeof progress === "number" &&
        Number.isFinite(progress) &&
        progress >= 0 &&
        progress <= 100)
    ) ||
    !(
      value.sessionId === null ||
      (typeof value.sessionId === "string" && SAFE_ID.test(value.sessionId))
    ) ||
    !(value.sessionUrl === null || typeof value.sessionUrl === "string")
  ) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "preview-local status returned malformed progress data",
    );
  }
  const canonical: PreviewDevelopmentStatusResult = Object.freeze({
    kind: "get-workflow-status" as const,
    operationId: input.operationId,
    target: input.target,
    ...input.workflow,
    status,
    phase: safeRemoteProgressLabel(value.phase),
    progress: progress as number | null,
    currentNodeId: safeRemoteNodeId(value.currentNodeId),
    controlReady: value.controlReady,
    sessionId: value.sessionId as string | null,
    sessionUrl: value.sessionUrl as string | null,
    error: status === "error" ? "preview development child failed" : null,
    output: canonicalStatusOutput({
      status,
      output: value.output,
      target: input.target,
      executionId: input.workflow.executionId,
    }),
    terminal,
  });
  if (!validSessionLink(canonical, input.target, expectedOrigin)) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "preview-local status returned an invalid interactive session link",
    );
  }
  return canonical;
}

function canonicalRemoteSignalResult(
  result: unknown,
  input: PreviewDevelopmentBrokerSignalInput,
): PreviewDevelopmentSignalResult {
  const value = remoteResultRecord(result, input, "signal-workflow");
  if (value.action !== input.action || value.accepted !== true) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "preview-local signal returned an invalid acknowledgement",
    );
  }
  return Object.freeze({
    kind: "signal-workflow" as const,
    operationId: input.operationId,
    target: input.target,
    ...input.workflow,
    action: input.action,
    accepted: true as const,
  });
}

function trustedPhysicalPreviewOrigin(
  value: string | null,
  target: PreviewDevelopmentTarget,
): string {
  if (typeof value !== "string") {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "physical preview has no canonical HTTPS origin",
    );
  }
  try {
    const url = new URL(value);
    const labels = url.hostname.split(".");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      labels.length < 4 ||
      labels[0] !== `wfb-${target.previewName}` ||
      labels.at(-2) !== "ts" ||
      labels.at(-1) !== "net" ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash
    ) {
      throw new Error("untrusted origin");
    }
    return url.origin;
  } catch {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "physical preview has an invalid canonical HTTPS origin",
    );
  }
}

function executionSpecDigest(executionIr: unknown): `sha256:${string}` | null {
  if (
    !executionIr ||
    typeof executionIr !== "object" ||
    Array.isArray(executionIr)
  ) {
    return null;
  }
  const record = executionIr as Record<string, unknown>;
  return record.spec === undefined ? null : workflowSpecDigest(record.spec);
}

type StoredDevelopmentContext = Readonly<{
  version: 2;
  parentExecutionId: string;
  remoteActorUserId: string;
  operationId: string;
  target: PreviewDevelopmentTarget;
  workflowSpecDigest: `sha256:${string}`;
}>;

function readStoredContext(
  input: Record<string, unknown> | null,
): StoredDevelopmentContext {
  const raw = input?.[CONTEXT_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "child execution is not bound to a preview development command",
    );
  }
  const value = raw as Record<string, unknown>;
  const target = value.target as PreviewDevelopmentTarget;
  if (
    value.version !== 2 ||
    typeof value.parentExecutionId !== "string" ||
    !SAFE_ID.test(value.parentExecutionId) ||
    typeof value.remoteActorUserId !== "string" ||
    !SAFE_ID.test(value.remoteActorUserId) ||
    typeof value.operationId !== "string" ||
    !OPERATION_ID.test(value.operationId) ||
    !value.operationId.startsWith("pdt-start-workflow-") ||
    typeof value.workflowSpecDigest !== "string" ||
    !SPEC_DIGEST.test(value.workflowSpecDigest) ||
    !target ||
    typeof target !== "object"
  ) {
    throw new PreviewTargetDevelopmentError(
      "contract-mismatch",
      "child execution has an invalid preview development binding",
    );
  }
  asIdentity(target);
  return {
    version: 2,
    parentExecutionId: value.parentExecutionId,
    remoteActorUserId: value.remoteActorUserId,
    operationId: value.operationId,
    target,
    workflowSpecDigest: value.workflowSpecDigest as `sha256:${string}`,
  };
}

type HostDeps = Readonly<{
  executions: Pick<WorkflowExecutionRepository, "getById">;
  definitions: Pick<WorkflowDefinitionRepository, "getByRef">;
  admins: PreviewControlAdminAuthorizationPort;
  broker: PreviewTargetDevelopmentBrokerPort;
  scope: PreviewDeploymentScopePort;
}>;

/** Host-side application service. User identity is derived only from the parent run. */
export class ApplicationPreviewTargetDevelopmentService implements PreviewTargetDevelopmentPort {
  constructor(private readonly deps: HostDeps) {}

  async startWorkflow(
    input: Parameters<PreviewTargetDevelopmentPort["startWorkflow"]>[0],
  ) {
    const actorUserId = await this.resolveActor(input.parentExecutionId);
    const operationId = validateOperationId(
      input.operationId,
      "start-workflow",
    );
    asIdentity(input.target);
    const workflowInput = normalizeWorkflowInput(input.workflowInput);
    const definition = await this.deps.definitions.getByRef({
      workflowId: PREVIEW_DEVELOPMENT_WORKFLOW_ID,
    });
    if (!definition) {
      throw new PreviewTargetDevelopmentError(
        "not-found",
        "preview development workflow is not installed on the host",
      );
    }
    const specDigest = workflowSpecDigest(definition.spec);
    const workflow = Object.freeze({
      executionId: childExecutionId({
        parentExecutionId: input.parentExecutionId,
        target: input.target,
        workflowSpecDigest: specDigest,
      }),
      workflowName: PREVIEW_DEVELOPMENT_WORKFLOW_NAME,
      workflowSpecDigest: specDigest,
    });
    return this.deps.broker.startWorkflow({
      parentExecutionId: input.parentExecutionId,
      actorUserId,
      target: input.target,
      workflow,
      operationId,
      workflowInput,
    });
  }

  async getWorkflowStatus(
    input: Parameters<PreviewTargetDevelopmentPort["getWorkflowStatus"]>[0],
  ) {
    const actorUserId = await this.resolveActor(input.parentExecutionId);
    validateOperationId(input.operationId, "get-workflow-status");
    asIdentity(input.target);
    validateWorkflowReceipt(input.workflow);
    return this.deps.broker.getWorkflowStatus({
      parentExecutionId: input.parentExecutionId,
      actorUserId,
      target: input.target,
      workflow: input.workflow,
      operationId: input.operationId,
    });
  }

  async signalWorkflow(
    input: Parameters<PreviewTargetDevelopmentPort["signalWorkflow"]>[0],
  ) {
    const actorUserId = await this.resolveActor(input.parentExecutionId);
    validateOperationId(input.operationId, "signal-workflow");
    asIdentity(input.target);
    validateWorkflowReceipt(input.workflow);
    if (input.action !== "submit_preview_pr" && input.action !== "discard") {
      return invalid("unsupported preview development control action");
    }
    return this.deps.broker.signalWorkflow({
      parentExecutionId: input.parentExecutionId,
      actorUserId,
      target: input.target,
      workflow: input.workflow,
      operationId: input.operationId,
      action: input.action,
    });
  }

  async verifyPromotion(
    input: Parameters<PreviewTargetDevelopmentPort["verifyPromotion"]>[0],
  ) {
    const actorUserId = await this.resolveActor(input.parentExecutionId);
    validateOperationId(input.operationId, "verify-promotion");
    asIdentity(input.target);
    validatePromotionCoordinates(input);
    const services = normalizePromotionServices(input.services);
    return this.deps.broker.verifyPromotion({
      parentExecutionId: input.parentExecutionId,
      actorUserId,
      operationId: input.operationId,
      target: input.target,
      childExecutionId: input.childExecutionId,
      receiptId: input.receiptId,
      services,
    });
  }

  private async resolveActor(parentExecutionId: string): Promise<string> {
    if (!this.deps.scope.isControlPlane()) {
      throw new PreviewTargetDevelopmentError(
        "unauthorized",
        "host preview development commands require the control-plane BFF",
      );
    }
    if (!SAFE_ID.test(parentExecutionId)) {
      return invalid("parent execution id is invalid");
    }
    const execution = await this.deps.executions.getById(parentExecutionId);
    if (!execution) {
      throw new PreviewTargetDevelopmentError(
        "not-found",
        "parent workflow execution was not found",
      );
    }
    if (!activeParentStatus(execution.status)) {
      throw new PreviewTargetDevelopmentError(
        "contract-mismatch",
        "parent workflow execution is not active",
      );
    }
    if (!(await this.deps.admins.isPlatformAdmin(execution.userId))) {
      throw new PreviewTargetDevelopmentError(
        "unauthorized",
        "parent workflow actor is not a platform administrator",
      );
    }
    return execution.userId;
  }
}

type BrokerDeps = Readonly<{
  previews: Pick<VclusterPreviewGatewayPort, "get">;
  authority: Pick<
    PreviewControlSourceAuthorityPort,
    "authorizeRuntime" | "authorizeRuntimeTuple"
  >;
  capabilities: PreviewControlCapabilityMintPort;
  transport: PreviewTargetDevelopmentLeafTransportPort;
  receipts: Pick<PreviewSourcePromotionReceiptStorePort, "getScoped">;
}>;

/** Physical-dev broker: reauthorizes the exact generation before each command. */
export class ApplicationPreviewTargetDevelopmentBrokerService implements PreviewTargetDevelopmentBrokerPort {
  constructor(private readonly deps: BrokerDeps) {}

  async startWorkflow(input: PreviewDevelopmentBrokerStartInput) {
    validateOperationId(input.operationId, "start-workflow");
    validateWorkflowReceipt(input.workflow);
    const workflowInput = normalizeWorkflowInput(input.workflowInput);
    const authorized = await this.deps.authority.authorizeRuntime({
      ...asIdentity(input.target),
      requiredServices: workflowInput.services,
    });
    const routing = await this.downstream(input, authorized.owner);
    const result = await this.deps.transport.startWorkflow({
      ...input,
      workflowInput,
      targetUrl: routing.targetUrl,
      capability: routing.capability,
    });
    return canonicalRemoteStartResult(result, input);
  }

  async getWorkflowStatus(input: PreviewDevelopmentBrokerStatusInput) {
    validateOperationId(input.operationId, "get-workflow-status");
    validateWorkflowReceipt(input.workflow);
    const authorized = await this.deps.authority.authorizeRuntimeTuple(
      asIdentity(input.target),
    );
    const routing = await this.downstream(input, authorized.owner);
    const result = await this.deps.transport.getWorkflowStatus({
      ...input,
      targetUrl: routing.targetUrl,
      capability: routing.capability,
    });
    return canonicalRemoteStatusResult(result, input, routing.expectedOrigin);
  }

  async signalWorkflow(input: PreviewDevelopmentBrokerSignalInput) {
    validateOperationId(input.operationId, "signal-workflow");
    validateWorkflowReceipt(input.workflow);
    if (input.action !== "submit_preview_pr" && input.action !== "discard") {
      return invalid("unsupported preview development control action");
    }
    const authorized = await this.deps.authority.authorizeRuntimeTuple(
      asIdentity(input.target),
    );
    const routing = await this.downstream(input, authorized.owner);
    const result = await this.deps.transport.signalWorkflow({
      ...input,
      targetUrl: routing.targetUrl,
      capability: routing.capability,
    });
    return canonicalRemoteSignalResult(result, input);
  }

  async verifyPromotion(input: PreviewDevelopmentBrokerVerifyPromotionInput) {
    validateOperationId(input.operationId, "verify-promotion");
    validatePromotionCoordinates(input);
    const services = normalizePromotionServices(input.services);
    const verifiedInput = { ...input, services };
    const authorized = await this.deps.authority.authorizeRuntimeTuple(
      asIdentity(input.target),
    );
    if (authorized.owner !== input.actorUserId) {
      throw new PreviewTargetDevelopmentError(
        "unauthorized",
        "parent workflow actor does not own this preview generation",
      );
    }
    await this.assertPhysicalTarget(verifiedInput, authorized.owner);
    const receipt = await this.deps.receipts.getScoped({
      receiptId: input.receiptId,
      previewName: input.target.previewName,
      requestId: input.target.environmentRequestId,
      executionId: input.childExecutionId,
      platformRevision: input.target.platformRevision as ImmutableGitSha,
      sourceRevision: input.target.sourceRevision as ImmutableGitSha,
      catalogDigest: input.target.catalogDigest,
      repository: SOURCE_REPOSITORY,
      baseBranch: SOURCE_BASE_BRANCH,
    });
    if (!receipt) {
      throw new PreviewTargetDevelopmentError(
        "contract-mismatch",
        "promotion receipt is not available for this preview development run",
      );
    }
    return canonicalPromotionVerification(
      verifiedInput,
      receipt,
      authorized.services,
    );
  }

  private async downstream(
    input: PreviewDevelopmentBrokerStatusInput,
    owner: string,
  ): Promise<{
    targetUrl: string | null;
    capability: string;
    expectedOrigin: string;
  }> {
    const preview = await this.assertPhysicalTarget(input, owner);
    const expectedOrigin = trustedPhysicalPreviewOrigin(
      preview.url,
      input.target,
    );
    return {
      targetUrl: preview.url,
      capability: this.deps.capabilities.mintControl(asIdentity(input.target)),
      expectedOrigin,
    };
  }

  private async assertPhysicalTarget(
    input: Readonly<{
      parentExecutionId: string;
      actorUserId: string;
      target: PreviewDevelopmentTarget;
    }>,
    owner: string,
  ) {
    if (!SAFE_ID.test(input.parentExecutionId)) {
      return invalid("parent execution id is invalid");
    }
    if (owner !== input.actorUserId) {
      throw new PreviewTargetDevelopmentError(
        "unauthorized",
        "parent workflow actor does not own this preview generation",
      );
    }
    const preview = await this.deps.previews.get(input.target.previewName);
    const requestId =
      typeof preview.provenance?.requestId === "string"
        ? preview.provenance.requestId
        : "";
    const parentBinding =
      typeof preview.provenance?.parentEnvironmentId === "string"
        ? preview.provenance.parentEnvironmentId
        : "";
    const expectedBindingPrefix = previewDevelopmentParentBindingPrefix(
      input.parentExecutionId,
    );
    const observed: PreviewDevelopmentTarget = {
      previewName: preview.name,
      environmentRequestId: requestId,
      platformRevision: preview.platformRevision ?? "",
      sourceRevision: preview.sourceRevision ?? "",
      catalogDigest: (preview.catalogDigest ?? "") as `sha256:${string}`,
    };
    if (
      !preview.ready ||
      preview.phase !== "ready" ||
      preview.profile !== "app-live" ||
      (preview.mode !== "live" && preview.mode !== "reconciled") ||
      preview.trustedCode !== true ||
      preview.pool !== null ||
      preview.origin?.kind !== "workflow" ||
      preview.origin.reference !== input.parentExecutionId ||
      !parentBinding.startsWith(expectedBindingPrefix) ||
      parentBinding.length !== expectedBindingPrefix.length + 64 ||
      !sameTarget(input.target, observed)
    ) {
      throw new PreviewTargetDevelopmentError(
        "contract-mismatch",
        "physical preview generation changed before command dispatch",
      );
    }
    return preview;
  }
}

type LocalDeps = Readonly<{
  identity: PreviewLocalControlIdentityPort;
  scope: PreviewDeploymentScopePort;
  definitions: Pick<WorkflowDefinitionRepository, "getByRef">;
  executions: Pick<
    WorkflowExecutionRepository,
    "getById" | "listSessionIdsByExecutionId"
  >;
  projects: Pick<WorkspaceProjectRepository, "getProjectExternalId">;
  starter: WorkflowRunStarterPort;
  events: Pick<WorkflowApprovalEventPort, "raiseWorkflowEvent">;
}>;

/** Preview-local command receiver. It never accepts an origin or credential. */
export class ApplicationPreviewTargetDevelopmentLocalService implements PreviewTargetDevelopmentLocalPort {
  constructor(private readonly deps: LocalDeps) {}

  async startWorkflow(input: PreviewDevelopmentBrokerStartInput) {
    validateOperationId(input.operationId, "start-workflow");
    const target = this.assertLocalTarget(input.target);
    const workflow = validateWorkflowReceipt(input.workflow);
    const expectedExecutionId = childExecutionId({
      parentExecutionId: input.parentExecutionId,
      target,
      workflowSpecDigest: workflow.workflowSpecDigest,
    });
    if (workflow.executionId !== expectedExecutionId) {
      throw new PreviewTargetDevelopmentError(
        "contract-mismatch",
        "child execution id is not bound to the parent preview generation",
      );
    }
    const definition = await this.deps.definitions.getByRef({
      workflowId: PREVIEW_DEVELOPMENT_WORKFLOW_ID,
    });
    if (!definition) {
      throw new PreviewTargetDevelopmentError(
        "not-found",
        "preview development workflow is not installed",
      );
    }
    if (workflowSpecDigest(definition.spec) !== workflow.workflowSpecDigest) {
      throw new PreviewTargetDevelopmentError(
        "contract-mismatch",
        "preview-local workflow spec differs from the host contract",
      );
    }
    const workflowInput = normalizeWorkflowInput(input.workflowInput);
    const storedContext: StoredDevelopmentContext = Object.freeze({
      version: 2,
      parentExecutionId: input.parentExecutionId,
      remoteActorUserId: input.actorUserId,
      operationId: input.operationId,
      target,
      workflowSpecDigest: workflow.workflowSpecDigest,
    });
    const result = await this.deps.starter.startWorkflowRun({
      workflowId: PREVIEW_DEVELOPMENT_WORKFLOW_ID,
      triggerData: {
        ...workflowInput,
        [CONTEXT_KEY]: storedContext,
      },
      executionId: workflow.executionId,
      idempotent: true,
      launchSurface: "dev-environment",
      launchOrigin: previewLaunchOrigin(this.deps.scope),
      expectedWorkflowSpecDigest: workflow.workflowSpecDigest,
    });
    if (!result.ok) {
      throw new PreviewTargetDevelopmentError(
        result.status === 404 ? "not-found" : "upstream-failure",
        result.error,
      );
    }
    if (
      result.executionId !== workflow.executionId ||
      result.workflowId !== PREVIEW_DEVELOPMENT_WORKFLOW_ID
    ) {
      throw new PreviewTargetDevelopmentError(
        "contract-mismatch",
        "canonical workflow start returned the wrong child identity",
      );
    }
    await this.assertExecutionBinding(input);
    return {
      kind: "start-workflow" as const,
      operationId: input.operationId,
      target,
      ...workflow,
      instanceId: result.instanceId,
      status: "running" as const,
      reused: result.reused === true,
    };
  }

  async getWorkflowStatus(input: PreviewDevelopmentBrokerStatusInput) {
    validateOperationId(input.operationId, "get-workflow-status");
    const target = this.assertLocalTarget(input.target);
    const execution = await this.assertExecutionBinding(input);
    const terminal =
      execution.status === "success" ||
      execution.status === "error" ||
      execution.status === "cancelled";
    const controlReady =
      !terminal &&
      (execution.currentNodeId === "await_control" ||
        execution.phase === "awaiting-control");
    const sessionIds = await this.deps.executions.listSessionIdsByExecutionId(
      execution.id,
    );
    const uniqueSessionIds = [...new Set(sessionIds)];
    if (
      controlReady &&
      (uniqueSessionIds.length > 1 ||
        sessionIds.length !== uniqueSessionIds.length)
    ) {
      throw new PreviewTargetDevelopmentError(
        "contract-mismatch",
        "preview development child is linked to an ambiguous interactive session set",
      );
    }
    if (controlReady && uniqueSessionIds.length !== 1) {
      throw new PreviewTargetDevelopmentError(
        "contract-mismatch",
        "preview development child reached control without one interactive session",
      );
    }
    const sessionId = uniqueSessionIds[0] ?? null;
    let sessionUrl: string | null = null;
    if (sessionId) {
      if (!execution.projectId) {
        throw new PreviewTargetDevelopmentError(
          "contract-mismatch",
          "preview development child session has no workspace project",
        );
      }
      const workspaceSlug = await this.deps.projects.getProjectExternalId(
        execution.projectId,
      );
      if (!workspaceSlug) {
        throw new PreviewTargetDevelopmentError(
          "contract-mismatch",
          "preview development child workspace is unavailable",
        );
      }
      sessionUrl = `${previewLaunchOrigin(this.deps.scope)}/workspaces/${encodeURIComponent(workspaceSlug)}/sessions/${encodeURIComponent(sessionId)}`;
    }
    return {
      kind: "get-workflow-status" as const,
      operationId: input.operationId,
      target,
      ...input.workflow,
      status: execution.status,
      phase: execution.phase,
      progress: execution.progress,
      currentNodeId: execution.currentNodeId,
      controlReady,
      sessionId,
      sessionUrl,
      error: execution.error,
      output: canonicalStatusOutput({
        status: execution.status,
        output: execution.output,
        target,
        executionId: execution.id,
      }),
      terminal,
    };
  }

  async signalWorkflow(input: PreviewDevelopmentBrokerSignalInput) {
    validateOperationId(input.operationId, "signal-workflow");
    const target = this.assertLocalTarget(input.target);
    if (input.action !== "submit_preview_pr" && input.action !== "discard") {
      return invalid("unsupported preview development control action");
    }
    const execution = await this.assertExecutionBinding(input);
    if (terminalExecutionStatus(execution.status)) {
      if (outputControlAction(execution.output) !== input.action) {
        throw new PreviewTargetDevelopmentError(
          "contract-mismatch",
          "child workflow is terminal with a different control action",
        );
      }
      return {
        kind: "signal-workflow" as const,
        operationId: input.operationId,
        target,
        ...input.workflow,
        action: input.action,
        accepted: true as const,
      };
    }
    if (!execution.daprInstanceId) {
      throw new PreviewTargetDevelopmentError(
        "not-ready",
        "child workflow has no durable instance id",
      );
    }
    const raised = await this.deps.events.raiseWorkflowEvent({
      instanceId: execution.daprInstanceId,
      eventName: "preview.development.control",
      eventData: { action: input.action },
    });
    if (!raised.ok) {
      throw new PreviewTargetDevelopmentError(
        raised.status === 404 ? "not-found" : "upstream-failure",
        raised.detail || "failed to signal preview development workflow",
      );
    }
    return {
      kind: "signal-workflow" as const,
      operationId: input.operationId,
      target,
      ...input.workflow,
      action: input.action,
      accepted: true as const,
    };
  }

  private assertLocalTarget(
    target: PreviewDevelopmentTarget,
  ): PreviewDevelopmentTarget {
    const expected = targetFromIdentity(
      this.deps.identity.current(target.previewName),
    );
    if (!sameTarget(target, expected)) {
      throw new PreviewTargetDevelopmentError(
        "contract-mismatch",
        "preview-local generation does not match the command target",
      );
    }
    const scope = this.deps.scope.current();
    if (
      scope.kind !== "preview" ||
      scope.preview.name !== target.previewName ||
      scope.preview.profile !== "app-live" ||
      scope.preview.platformRevision !== target.platformRevision ||
      scope.preview.sourceRevision !== target.sourceRevision
    ) {
      throw new PreviewTargetDevelopmentError(
        "contract-mismatch",
        "preview-local deployment scope does not match the command target",
      );
    }
    return expected;
  }

  private async assertExecutionBinding(
    input: PreviewDevelopmentBrokerStatusInput,
  ) {
    validateWorkflowReceipt(input.workflow);
    const execution = await this.deps.executions.getById(
      input.workflow.executionId,
    );
    if (!execution) {
      throw new PreviewTargetDevelopmentError(
        "not-found",
        "preview development child execution was not found",
      );
    }
    const definition = await this.deps.definitions.getByRef({
      workflowId: execution.workflowId,
    });
    const context = readStoredContext(execution.input);
    const executedDigest = executionSpecDigest(execution.executionIr);
    const expectedExecutionId = childExecutionId({
      parentExecutionId: context.parentExecutionId,
      target: context.target,
      workflowSpecDigest: context.workflowSpecDigest,
    });
    if (
      !definition ||
      definition.id !== PREVIEW_DEVELOPMENT_WORKFLOW_ID ||
      execution.userId !== definition.userId ||
      execution.projectId !== definition.projectId ||
      context.remoteActorUserId !== input.actorUserId ||
      execution.id !== expectedExecutionId ||
      (executedDigest !== null &&
        executedDigest !== input.workflow.workflowSpecDigest) ||
      context.parentExecutionId !== input.parentExecutionId ||
      context.workflowSpecDigest !== input.workflow.workflowSpecDigest ||
      !sameTarget(context.target, input.target)
    ) {
      throw new PreviewTargetDevelopmentError(
        "contract-mismatch",
        "child execution does not match the exact preview workflow contract",
      );
    }
    return execution;
  }
}

export const __previewTargetDevelopmentForTest = Object.freeze({
  childExecutionId,
  normalizeWorkflowInput,
  promotionBranch,
  validSessionLink,
  validateOperationId,
});

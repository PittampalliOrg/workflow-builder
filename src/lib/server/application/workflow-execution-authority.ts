import type {
  PreviewDevelopmentExecutionBinding,
  PreviewDevelopmentTarget,
  PreviewWorkspaceExecutionBinding,
  WorkflowExecutionAuthority,
} from "$lib/server/application/ports";
import { validatePreviewControlIdentity } from "$lib/server/application/preview-control-identity";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const START_OPERATION = /^pdt-start-workflow-[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readAuthority(executionIr: unknown): Record<string, unknown> | null {
  return record(record(executionIr)?.authority);
}

function readTarget(value: unknown): PreviewDevelopmentTarget | null {
  const target = record(value);
  if (
    typeof target?.previewName !== "string" ||
    typeof target.environmentRequestId !== "string" ||
    typeof target.platformRevision !== "string" ||
    !FULL_SHA.test(target.platformRevision) ||
    typeof target.sourceRevision !== "string" ||
    !FULL_SHA.test(target.sourceRevision) ||
    typeof target.catalogDigest !== "string" ||
    !SHA256.test(target.catalogDigest)
  ) {
    return null;
  }
  try {
    validatePreviewControlIdentity({
      previewName: target.previewName,
      environmentRequestId: target.environmentRequestId,
      environmentPlatformRevision: target.platformRevision,
      environmentSourceRevision: target.sourceRevision,
      catalogDigest: target.catalogDigest as `sha256:${string}`,
    });
  } catch {
    return null;
  }
  return Object.freeze({
    previewName: target.previewName,
    environmentRequestId: target.environmentRequestId,
    platformRevision: target.platformRevision,
    sourceRevision: target.sourceRevision,
    catalogDigest: target.catalogDigest as `sha256:${string}`,
  });
}

export function readPreviewDevelopmentExecutionBinding(
  executionIr: unknown,
): PreviewDevelopmentExecutionBinding | null {
  const raw = record(readAuthority(executionIr)?.previewDevelopment);
  const target = readTarget(raw?.target);
  if (
    raw?.version !== 2 ||
    typeof raw.parentExecutionId !== "string" ||
    !SAFE_ID.test(raw.parentExecutionId) ||
    typeof raw.remoteActorUserId !== "string" ||
    !SAFE_ID.test(raw.remoteActorUserId) ||
    typeof raw.operationId !== "string" ||
    !START_OPERATION.test(raw.operationId) ||
    typeof raw.workflowSpecDigest !== "string" ||
    !SHA256.test(raw.workflowSpecDigest) ||
    !target
  ) {
    return null;
  }
  return Object.freeze({
    version: 2,
    parentExecutionId: raw.parentExecutionId,
    remoteActorUserId: raw.remoteActorUserId,
    operationId: raw.operationId,
    target,
    workflowSpecDigest: raw.workflowSpecDigest as `sha256:${string}`,
  });
}

function readPreviewWorkspaceExecutionBinding(
  executionIr: unknown,
): PreviewWorkspaceExecutionBinding | null {
  const raw = record(readAuthority(executionIr)?.previewWorkspace);
  const target = record(raw?.target);
  if (
    raw?.version !== 1 ||
    typeof target?.previewName !== "string" ||
    typeof target.environmentRequestId !== "string" ||
    typeof target.platformRevision !== "string" ||
    !FULL_SHA.test(target.platformRevision) ||
    typeof target.sourceRevision !== "string" ||
    !FULL_SHA.test(target.sourceRevision) ||
    typeof target.catalogDigest !== "string" ||
    !SHA256.test(target.catalogDigest)
  ) {
    return null;
  }
  return Object.freeze({
    version: 1,
    target: Object.freeze({
      previewName: target.previewName,
      environmentRequestId: target.environmentRequestId,
      platformRevision: target.platformRevision,
      sourceRevision: target.sourceRevision,
      catalogDigest: target.catalogDigest as `sha256:${string}`,
    }),
  });
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

function samePreviewDevelopment(
  left: PreviewDevelopmentExecutionBinding,
  right: PreviewDevelopmentExecutionBinding,
): boolean {
  return (
    left.version === right.version &&
    left.parentExecutionId === right.parentExecutionId &&
    left.remoteActorUserId === right.remoteActorUserId &&
    left.operationId === right.operationId &&
    left.workflowSpecDigest === right.workflowSpecDigest &&
    sameTarget(left.target, right.target)
  );
}

function samePreviewWorkspace(
  left: PreviewWorkspaceExecutionBinding,
  right: PreviewWorkspaceExecutionBinding,
): boolean {
  return (
    left.version === right.version && sameTarget(left.target, right.target)
  );
}

export function buildWorkflowExecutionAuthority(input: {
  previewWorkspace?: PreviewWorkspaceExecutionBinding;
  previewDevelopment?: PreviewDevelopmentExecutionBinding;
}): WorkflowExecutionAuthority | undefined {
  if (!input.previewWorkspace && !input.previewDevelopment) return undefined;
  return Object.freeze({
    ...(input.previewWorkspace
      ? { previewWorkspace: input.previewWorkspace }
      : {}),
    ...(input.previewDevelopment
      ? { previewDevelopment: input.previewDevelopment }
      : {}),
  });
}

/**
 * Idempotent reuse is valid only when both known preview bindings are exactly
 * the bindings derived for this attempt. Missing, malformed, stale, or extra
 * preview authority fails closed.
 */
export function matchesWorkflowExecutionAuthority(
  executionIr: unknown,
  expected: WorkflowExecutionAuthority | undefined,
): boolean {
  const authority = readAuthority(executionIr);
  const rawWorkspace = authority?.previewWorkspace;
  const rawDevelopment = authority?.previewDevelopment;
  const actualWorkspace = readPreviewWorkspaceExecutionBinding(executionIr);
  const actualDevelopment = readPreviewDevelopmentExecutionBinding(executionIr);

  if (expected?.previewWorkspace) {
    if (
      !actualWorkspace ||
      !samePreviewWorkspace(actualWorkspace, expected.previewWorkspace)
    ) {
      return false;
    }
  } else if (rawWorkspace !== undefined) {
    return false;
  }

  if (expected?.previewDevelopment) {
    if (
      !actualDevelopment ||
      !samePreviewDevelopment(actualDevelopment, expected.previewDevelopment)
    ) {
      return false;
    }
  } else if (rawDevelopment !== undefined) {
    return false;
  }

  return true;
}

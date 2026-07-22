import type {
  PreviewDevelopmentBrokerSignalInput,
  PreviewDevelopmentBrokerStartInput,
  PreviewDevelopmentBrokerStatusInput,
  PreviewDevelopmentBrokerVerifyPromotionInput,
  PreviewDevelopmentBuilderProfile,
  PreviewDevelopmentControlAction,
  PreviewDevelopmentTarget,
  PreviewDevelopmentWorkflowInput,
} from "$lib/server/application/ports";
import { PREVIEW_DEVELOPMENT_WORKFLOW_NAME } from "$lib/server/application/ports";

type HostCommand =
  | Readonly<{
      kind: "start-workflow";
      operationId: string;
      target: PreviewDevelopmentTarget;
      input: PreviewDevelopmentWorkflowInput;
    }>
  | Readonly<{
      kind: "get-workflow-status";
      operationId: string;
      target: PreviewDevelopmentTarget;
      executionId: string;
      workflowSpecDigest: `sha256:${string}`;
    }>
  | Readonly<{
      kind: "signal-workflow";
      operationId: string;
      target: PreviewDevelopmentTarget;
      executionId: string;
      workflowSpecDigest: `sha256:${string}`;
      action: PreviewDevelopmentControlAction;
    }>
  | Readonly<{
      kind: "verify-promotion";
      operationId: string;
      target: PreviewDevelopmentTarget;
      childExecutionId: string;
      receiptId: string;
      services: readonly string[];
    }>;

export type PreviewDevelopmentHostRequest = Readonly<{
  parentExecutionId: string;
  command: HostCommand;
}>;

export type PreviewDevelopmentWireRequest =
  | (PreviewDevelopmentBrokerStartInput & Readonly<{ kind: "start-workflow" }>)
  | (PreviewDevelopmentBrokerStatusInput &
      Readonly<{ kind: "get-workflow-status" }>)
  | (PreviewDevelopmentBrokerSignalInput &
      Readonly<{ kind: "signal-workflow" }>)
  | (PreviewDevelopmentBrokerVerifyPromotionInput &
      Readonly<{ kind: "verify-promotion" }>);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const supported = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !supported.has(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${label} has unsupported fields: ${unexpected.sort().join(", ")}`,
    );
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => string(item, `${label}[${index}]`));
}

function target(value: unknown): PreviewDevelopmentTarget {
  const raw = object(value, "target");
  assertKeys(
    raw,
    [
      "previewName",
      "environmentRequestId",
      "platformRevision",
      "sourceRevision",
      "catalogDigest",
    ],
    "target",
  );
  return {
    previewName: string(raw.previewName, "target.previewName"),
    environmentRequestId: string(
      raw.environmentRequestId,
      "target.environmentRequestId",
    ),
    platformRevision: string(raw.platformRevision, "target.platformRevision"),
    sourceRevision: string(raw.sourceRevision, "target.sourceRevision"),
    catalogDigest: string(
      raw.catalogDigest,
      "target.catalogDigest",
    ) as `sha256:${string}`,
  };
}

function workflowInput(value: unknown): PreviewDevelopmentWorkflowInput {
  const raw = object(value, "workflowInput");
  assertKeys(
    raw,
    [
      "intent",
      "services",
      "builderProfile",
      "targetRoutes",
      "keepPreview",
      "ttlHours",
      "retainAfterCompletion",
      "interactiveHandoff",
      "impactReview",
      "diffScope",
      "maxIterations",
    ],
    "workflowInput",
  );
  if (!Array.isArray(raw.services)) {
    throw new Error("workflowInput.services must be an array");
  }
  const builderProfile = raw.builderProfile;
  if (builderProfile !== undefined && typeof builderProfile !== "string") {
    throw new Error("workflowInput.builderProfile must be a string");
  }
  const targetRoutes = raw.targetRoutes;
  if (targetRoutes !== undefined && !Array.isArray(targetRoutes)) {
    throw new Error("workflowInput.targetRoutes must be an array");
  }
  const keepPreview = raw.keepPreview;
  if (
    keepPreview !== undefined &&
    typeof keepPreview !== "boolean" &&
    typeof keepPreview !== "string"
  ) {
    throw new Error("workflowInput.keepPreview must be a boolean");
  }
  // Additive child controls are shape-checked here, then range/enum-validated
  // by normalizeWorkflowInput before they cross an application boundary.
  const ttlHours = raw.ttlHours;
  if (ttlHours !== undefined && typeof ttlHours !== "number") {
    throw new Error("workflowInput.ttlHours must be a number");
  }
  const retainAfterCompletion = raw.retainAfterCompletion;
  if (
    retainAfterCompletion !== undefined &&
    typeof retainAfterCompletion !== "boolean" &&
    typeof retainAfterCompletion !== "string"
  ) {
    throw new Error("workflowInput.retainAfterCompletion must be a boolean");
  }
  const interactiveHandoff = raw.interactiveHandoff;
  if (
    interactiveHandoff !== undefined &&
    typeof interactiveHandoff !== "boolean" &&
    typeof interactiveHandoff !== "string"
  ) {
    throw new Error("workflowInput.interactiveHandoff must be a boolean");
  }
  const impactReview = raw.impactReview;
  if (
    impactReview !== undefined &&
    typeof impactReview !== "boolean" &&
    typeof impactReview !== "string"
  ) {
    throw new Error("workflowInput.impactReview must be a boolean");
  }
  const diffScope = raw.diffScope;
  if (diffScope !== undefined && !Array.isArray(diffScope)) {
    throw new Error("workflowInput.diffScope must be an array");
  }
  const maxIterations = raw.maxIterations;
  if (maxIterations !== undefined && typeof maxIterations !== "number") {
    throw new Error("workflowInput.maxIterations must be a number");
  }
  return {
    intent: string(raw.intent, "workflowInput.intent"),
    services: raw.services.map((service, index) =>
      string(service, `workflowInput.services[${index}]`),
    ),
    ...(builderProfile !== undefined
      ? { builderProfile: builderProfile as PreviewDevelopmentBuilderProfile }
      : {}),
    ...(targetRoutes !== undefined
      ? {
          targetRoutes: targetRoutes.map((route, index) =>
            string(route, `workflowInput.targetRoutes[${index}]`),
          ),
        }
      : {}),
    ...(keepPreview !== undefined ? { keepPreview } : {}),
    ...(ttlHours !== undefined ? { ttlHours } : {}),
    ...(retainAfterCompletion !== undefined ? { retainAfterCompletion } : {}),
    ...(interactiveHandoff !== undefined ? { interactiveHandoff } : {}),
    ...(impactReview !== undefined ? { impactReview } : {}),
    ...(diffScope !== undefined
      ? {
          diffScope: diffScope.map((prefix, index) =>
            string(prefix, `workflowInput.diffScope[${index}]`),
          ),
        }
      : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
  };
}

function action(value: unknown): PreviewDevelopmentControlAction {
  if (value !== "submit_preview_pr" && value !== "discard") {
    throw new Error("unsupported preview development control action");
  }
  return value;
}

function hostCommand(value: unknown): HostCommand {
  const raw = object(value, "command");
  const kind = raw.kind;
  if (kind === "start-workflow") {
    assertKeys(raw, ["kind", "operationId", "target", "input"], "command");
    return {
      kind,
      operationId: string(raw.operationId, "command.operationId"),
      target: target(raw.target),
      input: workflowInput(raw.input),
    };
  }
  if (kind === "get-workflow-status") {
    assertKeys(
      raw,
      ["kind", "operationId", "target", "executionId", "workflowSpecDigest"],
      "command",
    );
    return {
      kind,
      operationId: string(raw.operationId, "command.operationId"),
      target: target(raw.target),
      executionId: string(raw.executionId, "command.executionId"),
      workflowSpecDigest: string(
        raw.workflowSpecDigest,
        "command.workflowSpecDigest",
      ) as `sha256:${string}`,
    };
  }
  if (kind === "signal-workflow") {
    assertKeys(
      raw,
      [
        "kind",
        "operationId",
        "target",
        "executionId",
        "workflowSpecDigest",
        "action",
      ],
      "command",
    );
    return {
      kind,
      operationId: string(raw.operationId, "command.operationId"),
      target: target(raw.target),
      executionId: string(raw.executionId, "command.executionId"),
      workflowSpecDigest: string(
        raw.workflowSpecDigest,
        "command.workflowSpecDigest",
      ) as `sha256:${string}`,
      action: action(raw.action),
    };
  }
  if (kind === "verify-promotion") {
    assertKeys(
      raw,
      [
        "kind",
        "operationId",
        "target",
        "childExecutionId",
        "receiptId",
        "services",
      ],
      "command",
    );
    return {
      kind,
      operationId: string(raw.operationId, "command.operationId"),
      target: target(raw.target),
      childExecutionId: string(
        raw.childExecutionId,
        "command.childExecutionId",
      ),
      receiptId: string(raw.receiptId, "command.receiptId"),
      services: stringArray(raw.services, "command.services"),
    };
  }
  throw new Error("unsupported preview development command");
}

export function parsePreviewDevelopmentHostRequest(
  value: Record<string, unknown>,
): PreviewDevelopmentHostRequest {
  assertKeys(value, ["parentExecutionId", "command"], "request");
  return {
    parentExecutionId: string(value.parentExecutionId, "parentExecutionId"),
    command: hostCommand(value.command),
  };
}

export function parsePreviewDevelopmentWireRequest(
  value: Record<string, unknown>,
): PreviewDevelopmentWireRequest {
  assertKeys(value, ["parentExecutionId", "command"], "request");
  const parsedCommand = object(value.command, "command");
  const kind = parsedCommand.kind;
  const parentExecutionId = string(
    value.parentExecutionId,
    "parentExecutionId",
  );
  const actorUserId = string(parsedCommand.actorUserId, "command.actorUserId");
  const operationId = string(parsedCommand.operationId, "command.operationId");
  const parsedTarget = target(parsedCommand.target);
  if (kind === "verify-promotion") {
    assertKeys(
      parsedCommand,
      [
        "kind",
        "actorUserId",
        "operationId",
        "target",
        "childExecutionId",
        "receiptId",
        "services",
      ],
      "command",
    );
    return {
      kind,
      parentExecutionId,
      actorUserId,
      operationId,
      target: parsedTarget,
      childExecutionId: string(
        parsedCommand.childExecutionId,
        "command.childExecutionId",
      ),
      receiptId: string(parsedCommand.receiptId, "command.receiptId"),
      services: stringArray(parsedCommand.services, "command.services"),
    };
  }
  const base = {
    parentExecutionId,
    actorUserId,
    operationId,
    target: parsedTarget,
    workflow: {
      executionId: string(parsedCommand.executionId, "command.executionId"),
      workflowName: PREVIEW_DEVELOPMENT_WORKFLOW_NAME,
      workflowSpecDigest: string(
        parsedCommand.workflowSpecDigest,
        "command.workflowSpecDigest",
      ) as `sha256:${string}`,
    },
  };
  if (kind === "start-workflow") {
    assertKeys(
      parsedCommand,
      [
        "kind",
        "actorUserId",
        "operationId",
        "target",
        "executionId",
        "workflowSpecDigest",
        "input",
      ],
      "command",
    );
    return {
      ...base,
      kind,
      workflowInput: workflowInput(parsedCommand.input),
    };
  }
  if (kind === "get-workflow-status") {
    assertKeys(
      parsedCommand,
      [
        "kind",
        "actorUserId",
        "operationId",
        "target",
        "executionId",
        "workflowSpecDigest",
      ],
      "command",
    );
    return { ...base, kind };
  }
  if (kind === "signal-workflow") {
    assertKeys(
      parsedCommand,
      [
        "kind",
        "actorUserId",
        "operationId",
        "target",
        "executionId",
        "workflowSpecDigest",
        "action",
      ],
      "command",
    );
    return { ...base, kind, action: action(parsedCommand.action) };
  }
  throw new Error("unsupported preview development command");
}

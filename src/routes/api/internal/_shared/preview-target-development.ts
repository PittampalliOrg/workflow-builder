import type {
  PreviewDevelopmentBrokerSignalInput,
  PreviewDevelopmentBrokerStartInput,
  PreviewDevelopmentBrokerStatusInput,
  PreviewDevelopmentBrokerVerifyPromotionInput,
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
    ["intent", "services", "agentSlug", "keepPreview"],
    "workflowInput",
  );
  if (!Array.isArray(raw.services)) {
    throw new Error("workflowInput.services must be an array");
  }
  const agentSlug = raw.agentSlug;
  if (agentSlug !== undefined && typeof agentSlug !== "string") {
    throw new Error("workflowInput.agentSlug must be a string");
  }
  const keepPreview = raw.keepPreview;
  if (
    keepPreview !== undefined &&
    typeof keepPreview !== "boolean" &&
    typeof keepPreview !== "string"
  ) {
    throw new Error("workflowInput.keepPreview must be a boolean");
  }
  return {
    intent: string(raw.intent, "workflowInput.intent"),
    services: raw.services.map((service, index) =>
      string(service, `workflowInput.services[${index}]`),
    ),
    ...(agentSlug !== undefined ? { agentSlug } : {}),
    ...(keepPreview !== undefined ? { keepPreview } : {}),
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

import type {
  PreviewDevelopmentEnvironmentLaunchInput,
  PreviewDevelopmentTarget,
} from "$lib/server/application/ports";
import type { VclusterPreviewTeardownTicket } from "$lib/types/dev-previews";

type EnvironmentCommand =
  | Readonly<{
      kind: "launch-environment";
      operationId: string;
      input: PreviewDevelopmentEnvironmentLaunchInput;
    }>
  | Readonly<{
      kind: "get-environment-status" | "teardown-environment";
      operationId: string;
      target: PreviewDevelopmentTarget;
    }>
  | Readonly<{
      kind: "get-environment-teardown-status";
      operationId: string;
      target: PreviewDevelopmentTarget;
      ticket: VclusterPreviewTeardownTicket;
    }>;

export type PreviewDevelopmentEnvironmentRequest = Readonly<{
  parentExecutionId: string;
  command: EnvironmentCommand;
}>;

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
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
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

function ticket(value: unknown): VclusterPreviewTeardownTicket {
  const raw = object(value, "ticket");
  assertKeys(
    raw,
    ["name", "environmentUid", "requestId", "sourceRevision", "signature"],
    "ticket",
  );
  return {
    name: string(raw.name, "ticket.name"),
    environmentUid: string(raw.environmentUid, "ticket.environmentUid"),
    requestId: string(raw.requestId, "ticket.requestId"),
    sourceRevision: string(raw.sourceRevision, "ticket.sourceRevision"),
    signature: string(raw.signature, "ticket.signature"),
  };
}

function launchInput(value: unknown): PreviewDevelopmentEnvironmentLaunchInput {
  const raw = object(value, "command.input");
  assertKeys(
    raw,
    ["environmentName", "services", "ttlHours", "retainAfterCompletion"],
    "command.input",
  );
  if (!Array.isArray(raw.services)) {
    throw new Error("command.input.services must be an array");
  }
  if (typeof raw.ttlHours !== "number") {
    throw new Error("command.input.ttlHours must be a number");
  }
  if (typeof raw.retainAfterCompletion !== "boolean") {
    throw new Error("command.input.retainAfterCompletion must be a boolean");
  }
  return {
    environmentName: string(
      raw.environmentName,
      "command.input.environmentName",
    ),
    services: raw.services.map((service, index) =>
      string(service, `command.input.services[${index}]`),
    ),
    ttlHours: raw.ttlHours,
    retainAfterCompletion: raw.retainAfterCompletion,
  };
}

export function parsePreviewDevelopmentEnvironmentRequest(
  value: Record<string, unknown>,
): PreviewDevelopmentEnvironmentRequest {
  assertKeys(value, ["parentExecutionId", "command"], "request");
  const parentExecutionId = string(
    value.parentExecutionId,
    "parentExecutionId",
  );
  const raw = object(value.command, "command");
  const kind = raw.kind;
  if (kind === "launch-environment") {
    assertKeys(raw, ["kind", "operationId", "input"], "command");
    return {
      parentExecutionId,
      command: {
        kind,
        operationId: string(raw.operationId, "command.operationId"),
        input: launchInput(raw.input),
      },
    };
  }
  if (kind === "get-environment-status" || kind === "teardown-environment") {
    assertKeys(raw, ["kind", "operationId", "target"], "command");
    return {
      parentExecutionId,
      command: {
        kind,
        operationId: string(raw.operationId, "command.operationId"),
        target: target(raw.target),
      },
    };
  }
  if (kind === "get-environment-teardown-status") {
    assertKeys(raw, ["kind", "operationId", "target", "ticket"], "command");
    return {
      parentExecutionId,
      command: {
        kind,
        operationId: string(raw.operationId, "command.operationId"),
        target: target(raw.target),
        ticket: ticket(raw.ticket),
      },
    };
  }
  throw new Error("unsupported preview environment command");
}

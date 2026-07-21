import { createHash } from "node:crypto";
import { redactDrasiText } from "$lib/server/application/drasi-incidents";

const MAX_OBSERVATION_BYTES = 16_384;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const PHASES = new Set([
  "Healthy",
  "Pending",
  "Progressing",
  "Warning",
  "Degraded",
  "Drifted",
  "Deleted",
  "Finished",
]);
const RESOURCE_TYPES = new Map([
  ["Event", { group: "", resource: "events" }],
  ["Pod", { group: "", resource: "pods" }],
  ["Deployment", { group: "apps", resource: "deployments" }],
  ["Sandbox", { group: "agents.x-k8s.io", resource: "sandboxes" }],
  ["Workload", { group: "kueue.x-k8s.io", resource: "workloads" }],
  ["Component", { group: "dapr.io", resource: "components" }],
  ["Configuration", { group: "dapr.io", resource: "configurations" }],
  ["Resiliency", { group: "dapr.io", resource: "resiliencies" }],
  ["Subscription", { group: "dapr.io", resource: "subscriptions" }],
]);
const BODY_KEYS = new Set([
  "resourceRef",
  "phase",
  "reason",
  "message",
  "observedAt",
  "correlation",
]);
const RESOURCE_KEYS = new Set([
  "group",
  "version",
  "resource",
  "kind",
  "namespace",
  "name",
  "uid",
]);
const CORRELATION_KEYS = new Set([
  "cluster",
  "observer",
  "resourceVersion",
  "daprAppId",
]);

type JsonRecord = Record<string, unknown>;

export type NormalizeDrasiObservationResult =
  | { ok: true; currentEvent: JsonRecord; event: JsonRecord }
  | { ok: false; error: string };

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(
  value: unknown,
  name: string,
  options: { required?: boolean; max: number },
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") {
    return options.required
      ? { ok: false, error: `${name} is required` }
      : { ok: true, value: null };
  }
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: `${name} must be a string` };
  }
  const normalized = value.trim();
  if (normalized.length > options.max) {
    return { ok: false, error: `${name} exceeds ${options.max} characters` };
  }
  return { ok: true, value: redactDrasiText(normalized) };
}

function exactKeys(value: JsonRecord, allowed: ReadonlySet<string>, path: string) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  return unknown ? `${path}${unknown} is not allowed` : null;
}

export function normalizeDrasiObservation(
  body: unknown,
): NormalizeDrasiObservationResult {
  if (!isRecord(body)) return { ok: false, error: "body must be an object" };
  if (Buffer.byteLength(JSON.stringify(body), "utf8") > MAX_OBSERVATION_BYTES) {
    return { ok: false, error: `body exceeds ${MAX_OBSERVATION_BYTES} bytes` };
  }
  const bodyError = exactKeys(body, BODY_KEYS, "");
  if (bodyError) return { ok: false, error: bodyError };

  if (!isRecord(body.resourceRef)) {
    return { ok: false, error: "resourceRef must be an object" };
  }
  const resourceError = exactKeys(body.resourceRef, RESOURCE_KEYS, "resourceRef.");
  if (resourceError) return { ok: false, error: resourceError };
  const resourceRef: Record<string, string | null> = {};
  for (const [field, required, max] of [
    ["group", false, 100],
    ["version", true, 40],
    ["resource", true, 100],
    ["kind", true, 100],
    ["namespace", true, 100],
    ["name", true, 253],
    ["uid", false, 100],
  ] as const) {
    const result = stringField(body.resourceRef[field], `resourceRef.${field}`, {
      required,
      max,
    });
    if (!result.ok) return result;
    resourceRef[field] = result.value;
  }
  if (resourceRef.namespace !== "workflow-builder") {
    return { ok: false, error: "resourceRef.namespace is not observed" };
  }
  const expected = RESOURCE_TYPES.get(resourceRef.kind || "");
  if (
    !expected ||
    expected.group !== (resourceRef.group || "") ||
    expected.resource !== resourceRef.resource
  ) {
    return { ok: false, error: "resourceRef type is not allowlisted" };
  }

  const phase = stringField(body.phase, "phase", { required: true, max: 40 });
  if (!phase.ok) return phase;
  if (!PHASES.has(phase.value || "")) {
    return { ok: false, error: "phase is not allowlisted" };
  }
  const reason = stringField(body.reason, "reason", { max: 256 });
  if (!reason.ok) return reason;
  const message = stringField(body.message, "message", { max: 2_000 });
  if (!message.ok) return message;

  const observedAt = stringField(body.observedAt, "observedAt", {
    required: true,
    max: 64,
  });
  if (!observedAt.ok) return observedAt;
  if (!observedAt.value || !RFC3339.test(observedAt.value)) {
    return { ok: false, error: "observedAt must be an RFC3339 timestamp" };
  }
  const milliseconds = Date.parse(observedAt.value);
  if (Number.isNaN(milliseconds)) {
    return { ok: false, error: "observedAt must be an RFC3339 timestamp" };
  }

  const correlationInput = body.correlation ?? {};
  if (!isRecord(correlationInput)) {
    return { ok: false, error: "correlation must be an object" };
  }
  const correlationError = exactKeys(
    correlationInput,
    CORRELATION_KEYS,
    "correlation.",
  );
  if (correlationError) return { ok: false, error: correlationError };
  const correlation: Record<string, string> = {};
  for (const field of CORRELATION_KEYS) {
    const result = stringField(correlationInput[field], `correlation.${field}`, {
      max: 256,
    });
    if (!result.ok) return result;
    if (result.value) correlation[field] = result.value;
  }
  if (!correlation.cluster) {
    return { ok: false, error: "correlation.cluster is required" };
  }

  const identity = [
    correlation.cluster,
    resourceRef.group || "core",
    resourceRef.resource,
    resourceRef.namespace,
    resourceRef.name,
  ].join(":");
  const currentEventId = `drasi-k8s-current:${createHash("sha256").update(identity).digest("hex").slice(0, 24)}`;
  const canonicalObservedAt = new Date(milliseconds).toISOString();
  const transitionIdentity = [
    identity,
    resourceRef.uid || "",
    correlation.resourceVersion || "",
    phase.value,
    reason.value || "",
    canonicalObservedAt,
  ].join("\n");
  const eventId = `drasi-k8s:${createHash("sha256").update(transitionIdentity).digest("hex").slice(0, 24)}`;
  const baseEvent = {
    activityKey: `${resourceRef.kind}:${resourceRef.namespace}/${resourceRef.name}`,
    activityType: "kubernetes.resource",
    phase: phase.value,
    reason: reason.value,
    message: message.value,
    observedAt: canonicalObservedAt,
    resourceRef,
    correlation,
    raw: {},
  };

  return {
    ok: true,
    currentEvent: {
      ...baseEvent,
      eventId: currentEventId,
      source: "drasi-kubernetes-observer-current",
    },
    event: {
      ...baseEvent,
      eventId,
      source: "drasi-kubernetes-observer",
    },
  };
}

import { createHash } from "node:crypto";
import { redactDiagnosticEvidence } from "$lib/server/application/diagnostic-redaction";

const MAX_INCIDENT_BYTES = 32_768;
const MAX_KEY_LENGTH = 256;
const MAX_SUBJECT_LENGTH = 500;
const MAX_EVIDENCE_STRING_LENGTH = 2_000;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DRASI_POSTGRES_LOCAL_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/;
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const CLUSTER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const PLATFORM_INCIDENT_ANALYSIS_WORKFLOW_ID =
  "platform-incident-analysis";

export const DRASI_INCIDENT_QUERY_IDS = [
  "workflow-execution-stalled",
  "session-failure-storm",
  "sandbox-provisioning-stalled",
  "kueue-admission-stalled",
  "dapr-resource-warning",
  "dapr-resource-drift",
] as const;

type DrasiIncidentQueryId = (typeof DRASI_INCIDENT_QUERY_IDS)[number];
type EvidenceValue = string | number | boolean | null;

const INPUT_KEYS = new Set([
  "queryId",
  "episodeStartedAt",
  "severity",
  "subject",
  "executionId",
  "sessionId",
  "resourceKind",
  "resourceNamespace",
  "resourceName",
  "resourceUid",
  "evidence",
]);

const EVIDENCE_KEYS: Record<DrasiIncidentQueryId, ReadonlySet<string>> = {
  "workflow-execution-stalled": new Set([
    "workflowId",
    "status",
    "phase",
    "nodeId",
    "nodeName",
    "startedAt",
    "lastProgressAt",
    "stalledMinutes",
  ]),
  "session-failure-storm": new Set([
    "status",
    "eventType",
    "failureCount",
    "windowStartedAt",
    "lastEventAt",
    "errorMessage",
  ]),
  "sandbox-provisioning-stalled": new Set([
    "phase",
    "reason",
    "message",
    "conditionType",
    "conditionStatus",
    "ready",
    "observedAt",
    "stalledMinutes",
  ]),
  "kueue-admission-stalled": new Set([
    "phase",
    "reason",
    "message",
    "conditionType",
    "conditionStatus",
    "ready",
    "observedAt",
    "stalledMinutes",
  ]),
  "dapr-resource-warning": new Set([
    "phase",
    "reason",
    "message",
    "conditionType",
    "conditionStatus",
    "observedAt",
    "daprAppId",
  ]),
  "dapr-resource-drift": new Set([
    "phase",
    "reason",
    "message",
    "componentType",
    "actorStateStore",
    "observedAt",
    "daprAppId",
  ]),
};

export type DrasiIncidentEnvelope = {
  workflowId: string;
  triggerId: string;
  dedupKey: string;
  triggerData: Record<string, unknown>;
};

export type NormalizeDrasiIncidentResult =
  | { ok: true; envelope: DrasiIncidentEnvelope }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requiredString(
  value: unknown,
  name: string,
  maxLength: number,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, error: `${name} is required` };
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    return { ok: false, error: `${name} exceeds ${maxLength} characters` };
  }
  return { ok: true, value: normalized };
}

function optionalString(
  value: unknown,
  name: string,
  maxLength: number,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true };
  const result = requiredString(value, name, maxLength);
  return result.ok ? { ok: true, value: redactDrasiText(result.value) } : result;
}

function canonicalTimestamp(
  value: unknown,
  name: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const parsed = requiredString(value, name, 64);
  if (!parsed.ok) return parsed;
  const candidate = DRASI_POSTGRES_LOCAL_DATETIME.test(parsed.value)
    ? `${parsed.value}Z`
    : parsed.value;
  if (!RFC3339.test(candidate)) {
    return { ok: false, error: `${name} must be an RFC3339 timestamp` };
  }
  const milliseconds = Date.parse(candidate);
  if (Number.isNaN(milliseconds)) {
    return { ok: false, error: `${name} must be an RFC3339 timestamp` };
  }
  return { ok: true, value: new Date(milliseconds).toISOString() };
}

export function redactDrasiText(value: string): string {
  return redactDiagnosticEvidence(value);
}

function sanitizeEvidence(
  value: unknown,
  queryId: DrasiIncidentQueryId,
): { ok: true; value: Record<string, EvidenceValue> } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!isRecord(value)) return { ok: false, error: "evidence must be an object" };

  const allowed = EVIDENCE_KEYS[queryId];
  const sanitized: Record<string, EvidenceValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!allowed.has(key)) {
      return { ok: false, error: `evidence.${key} is not allowed for ${queryId}` };
    }
    if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
      return { ok: false, error: `evidence.${key} must be a primitive value` };
    }
    if (typeof item === "number" && !Number.isFinite(item)) {
      return { ok: false, error: `evidence.${key} must be finite` };
    }
    if (typeof item === "string") {
      if (item.length > MAX_EVIDENCE_STRING_LENGTH) {
        return {
          ok: false,
          error: `evidence.${key} exceeds ${MAX_EVIDENCE_STRING_LENGTH} characters`,
        };
      }
      sanitized[key] = redactDrasiText(item);
    } else {
      sanitized[key] = item as number | boolean | null;
    }
  }
  return { ok: true, value: sanitized };
}

function validateCorrelation(
  body: Record<string, unknown>,
  queryId: DrasiIncidentQueryId,
):
  | { ok: true; value: Record<string, string> }
  | { ok: false; error: string } {
  const fields = [
    "executionId",
    "sessionId",
    "resourceKind",
    "resourceNamespace",
    "resourceName",
    "resourceUid",
  ] as const;
  const value: Record<string, string> = {};
  for (const field of fields) {
    const result = optionalString(body[field], field, MAX_KEY_LENGTH);
    if (!result.ok) return result;
    if (result.value) {
      if (!CORRELATION_ID.test(result.value)) {
        return { ok: false, error: `${field} contains unsupported characters` };
      }
      value[field] = result.value;
    }
  }

  if (queryId === "workflow-execution-stalled" && !value.executionId) {
    return { ok: false, error: "executionId is required for workflow-execution-stalled" };
  }
  if (queryId === "session-failure-storm" && !value.sessionId) {
    return { ok: false, error: "sessionId is required for session-failure-storm" };
  }
  if (
    queryId !== "workflow-execution-stalled" &&
    queryId !== "session-failure-storm" &&
    (!value.resourceKind || !value.resourceNamespace || !value.resourceName)
  ) {
    return {
      ok: false,
      error: "resourceKind, resourceNamespace, and resourceName are required for resource incidents",
    };
  }
  return { ok: true, value };
}

function incidentKeyFor(
  queryId: DrasiIncidentQueryId,
  correlation: Record<string, string>,
  evidence: Record<string, EvidenceValue>,
): string {
  if (queryId === "workflow-execution-stalled") {
    const nodeIdentity = evidence.nodeId
      ? createHash("sha256").update(String(evidence.nodeId)).digest("hex").slice(0, 24)
      : "execution";
    return [queryId, correlation.executionId, nodeIdentity].join(":");
  }
  if (queryId === "session-failure-storm") {
    return [queryId, correlation.sessionId].join(":");
  }
  return [
    queryId,
    correlation.resourceKind,
    correlation.resourceNamespace,
    correlation.resourceName,
    correlation.resourceUid || "current",
  ].join(":");
}

export function normalizeDrasiIncident(
  body: unknown,
  options: { cluster: string },
): NormalizeDrasiIncidentResult {
  if (!isRecord(body)) return { ok: false, error: "body must be an object" };

  let serialized: string;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return { ok: false, error: "body must be JSON serializable" };
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_INCIDENT_BYTES) {
    return { ok: false, error: `body exceeds ${MAX_INCIDENT_BYTES} bytes` };
  }
  const unknownField = Object.keys(body).find((key) => !INPUT_KEYS.has(key));
  if (unknownField) return { ok: false, error: `${unknownField} is not allowed` };

  const queryId = requiredString(body.queryId, "queryId", 80);
  if (!queryId.ok) return queryId;
  if (!DRASI_INCIDENT_QUERY_IDS.includes(queryId.value as DrasiIncidentQueryId)) {
    return { ok: false, error: "queryId is not allowlisted" };
  }
  const typedQueryId = queryId.value as DrasiIncidentQueryId;

  const episodeStartedAt = canonicalTimestamp(body.episodeStartedAt, "episodeStartedAt");
  if (!episodeStartedAt.ok) return episodeStartedAt;

  const severity =
    typeof body.severity === "string" ? body.severity.trim().toLowerCase() : "warning";
  if (!["info", "warning", "critical"].includes(severity)) {
    return { ok: false, error: "severity must be info, warning, or critical" };
  }
  const subject = optionalString(body.subject, "subject", MAX_SUBJECT_LENGTH);
  if (!subject.ok) return subject;
  const correlation = validateCorrelation(body, typedQueryId);
  if (!correlation.ok) return correlation;
  const evidence = sanitizeEvidence(body.evidence, typedQueryId);
  if (!evidence.ok) return evidence;
  const incidentKey = incidentKeyFor(
    typedQueryId,
    correlation.value,
    evidence.value,
  );

  const cluster = options.cluster.trim() || "dev";
  if (cluster.length > MAX_KEY_LENGTH || !CLUSTER_ID.test(cluster)) {
    return { ok: false, error: "cluster contains unsupported characters or is too long" };
  }
  const episodeDigest = createHash("sha256")
    .update(`${incidentKey}\n${episodeStartedAt.value}`)
    .digest("hex")
    .slice(0, 24);
  const dedupKey = `drasi:${typedQueryId}:${cluster}:${episodeDigest}`;

  return {
    ok: true,
    envelope: {
      workflowId: PLATFORM_INCIDENT_ANALYSIS_WORKFLOW_ID,
      triggerId: `drasi:${typedQueryId}`,
      dedupKey,
      triggerData: {
        source: "drasi",
        cluster,
        queryId: typedQueryId,
        incidentType: typedQueryId,
        incidentKey,
        dedupKey,
        episodeStartedAt: episodeStartedAt.value,
        severity,
        subject: subject.value || typedQueryId,
        ...correlation.value,
        evidence: evidence.value,
      },
    },
  };
}

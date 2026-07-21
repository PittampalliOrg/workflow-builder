import { createHash } from "node:crypto";

const MAX_INCIDENT_BYTES = 32_768;
const MAX_KEY_LENGTH = 256;
const MAX_SUBJECT_LENGTH = 500;

export const DRASI_INCIDENT_QUERY_IDS = [
  "workflow-execution-stalled",
  "session-failure-storm",
  "sandbox-provisioning-stalled",
  "kueue-admission-stalled",
  "dapr-resource-warning",
  "dapr-resource-drift",
] as const;

type DrasiIncidentQueryId = (typeof DRASI_INCIDENT_QUERY_IDS)[number];

export type DrasiIncidentEnvelope = {
  workflowName: string;
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

export function normalizeDrasiIncident(
  body: unknown,
  options: { workflowName: string; cluster: string },
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

  const queryId = requiredString(body.queryId, "queryId", 80);
  if (!queryId.ok) return queryId;
  if (!DRASI_INCIDENT_QUERY_IDS.includes(queryId.value as DrasiIncidentQueryId)) {
    return { ok: false, error: "queryId is not allowlisted" };
  }

  const incidentKey = requiredString(body.incidentKey, "incidentKey", MAX_KEY_LENGTH);
  if (!incidentKey.ok) return incidentKey;
  const episodeStartedAt = requiredString(
    body.episodeStartedAt,
    "episodeStartedAt",
    64,
  );
  if (!episodeStartedAt.ok) return episodeStartedAt;
  if (Number.isNaN(Date.parse(episodeStartedAt.value))) {
    return { ok: false, error: "episodeStartedAt must be an ISO timestamp" };
  }

  const severity =
    typeof body.severity === "string" ? body.severity.trim().toLowerCase() : "warning";
  if (!["info", "warning", "critical"].includes(severity)) {
    return { ok: false, error: "severity must be info, warning, or critical" };
  }
  const subject =
    typeof body.subject === "string"
      ? body.subject.trim().slice(0, MAX_SUBJECT_LENGTH)
      : queryId.value;
  const evidence = isRecord(body.evidence) ? body.evidence : {};
  const cluster = options.cluster.trim() || "dev";
  const workflowName = options.workflowName.trim();
  if (!workflowName) return { ok: false, error: "incident workflow is not configured" };

  const episodeDigest = createHash("sha256")
    .update(`${incidentKey.value}\n${episodeStartedAt.value}`)
    .digest("hex")
    .slice(0, 24);
  const dedupKey = `drasi:${queryId.value}:${cluster}:${episodeDigest}`;

  return {
    ok: true,
    envelope: {
      workflowName,
      triggerId: `drasi:${queryId.value}`,
      dedupKey,
      triggerData: {
        source: "drasi",
        cluster,
        queryId: queryId.value,
        incidentType: queryId.value,
        incidentKey: incidentKey.value,
        dedupKey,
        episodeStartedAt: episodeStartedAt.value,
        severity,
        subject,
        evidence,
      },
    },
  };
}

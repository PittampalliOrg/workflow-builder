export const PLATFORM_INCIDENT_QUERY_IDS = [
	"workflow-execution-stalled",
	"session-failure-storm",
	"sandbox-provisioning-stalled",
	"kueue-admission-stalled",
	"dapr-resource-warning",
	"dapr-resource-drift",
] as const;

const PLATFORM_INCIDENT_EVIDENCE_KEYS = [
	"workflowId",
	"status",
	"phase",
	"nodeId",
	"nodeName",
	"startedAt",
	"lastProgressAt",
	"stalledMinutes",
	"eventType",
	"failureCount",
	"windowStartedAt",
	"lastEventAt",
	"errorMessage",
	"reason",
	"message",
	"conditionType",
	"conditionStatus",
	"ready",
	"observedAt",
	"daprAppId",
	"componentType",
	"actorStateStore",
] as const;

const platformIncidentEvidenceProperties = Object.fromEntries(
	PLATFORM_INCIDENT_EVIDENCE_KEYS.map((key) => [
		key,
		{
			oneOf: [
				{ type: "string", maxLength: 2_000 },
				{ type: "number" },
				{ type: "boolean" },
				{ type: "null" },
			],
		},
	]),
);

export const PLATFORM_INCIDENT_ANALYSIS_INPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: [
		"source",
		"cluster",
		"queryId",
		"incidentType",
		"incidentKey",
		"dedupKey",
		"episodeStartedAt",
		"severity",
		"evidence",
	],
	properties: {
		source: { type: "string", const: "drasi" },
		cluster: {
			type: "string",
			maxLength: 256,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
		},
		queryId: { type: "string", enum: PLATFORM_INCIDENT_QUERY_IDS },
		incidentType: { type: "string", enum: PLATFORM_INCIDENT_QUERY_IDS },
		incidentKey: {
			type: "string",
			maxLength: 1_280,
			pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$",
		},
		dedupKey: {
			type: "string",
			maxLength: 512,
			pattern: "^drasi:[A-Za-z0-9._:/-]+:[a-f0-9]{24}$",
		},
		episodeStartedAt: { type: "string", maxLength: 64, format: "date-time" },
		severity: { type: "string", enum: ["info", "warning", "critical"] },
		eventId: { type: "string", maxLength: 256 },
		subject: { type: "string", maxLength: 500 },
		executionId: { type: "string", maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" },
		sessionId: { type: "string", maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" },
		resourceKind: { type: "string", maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" },
		resourceNamespace: { type: "string", maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" },
		resourceName: { type: "string", maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" },
		resourceUid: { type: "string", maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9._:/-]*$" },
		evidence: {
			type: "object",
			additionalProperties: false,
			properties: platformIncidentEvidenceProperties,
		},
	},
} as const;

/**
 * Static, configured Drasi topology for the operations dashboard.
 *
 * This module is the single source of truth for *what is configured*:
 * observed systems, the Kubernetes observer projection, the two PostgreSQL
 * sources, the six continuous queries, the HTTP reaction, and the governed
 * incident workflow. It ships with the client bundle and must stay free of
 * server-only imports and secrets.
 *
 * Everything here is configuration. Dynamic health, counts, and activity are
 * NOT part of the catalog — the UI renders those as `Unavailable` unless a
 * real API response provides them.
 */
import type {
	DrasiEdgeSpec,
	DrasiNodeKind,
	DrasiNodeSpec,
	DrasiQueryRow,
	DrasiSourceRow,
} from "$lib/types/drasi";

export const DRASI_KIND_LABEL: Record<DrasiNodeKind, string> = {
	system: "Observed system",
	observer: "Observer",
	source: "Source",
	query: "Continuous query",
	reaction: "Reaction",
	workflow: "Governed workflow",
};

/** Restrained OKLCH accents — legible in both light and dark themes. */
const ACCENT: Record<DrasiNodeKind, string> = {
	system: "oklch(0.62 0.12 255)",
	observer: "oklch(0.66 0.13 195)",
	source: "oklch(0.62 0.13 235)",
	query: "oklch(0.6 0.14 300)",
	reaction: "oklch(0.66 0.15 75)",
	workflow: "oklch(0.62 0.13 160)",
};

export const POSTGRES_TABLES = [
	"workflow_executions",
	"workflow_execution_logs",
	"sessions",
	"session_events",
	"gitops_activity_events",
] as const;

export const K8S_WATCHED_KINDS = [
	"Pods",
	"Events",
	"Deployments",
	"Agent Sandboxes",
	"Kueue Workloads",
	"Dapr resources",
] as const;

const UNAVAILABLE_RUNTIME = "Runtime: Unavailable";

export const DRASI_NODES: DrasiNodeSpec[] = [
	{
		id: "sys-postgres",
		kind: "system",
		label: "Workflow Builder PostgreSQL",
		subtitle: "Application database",
		accent: ACCENT.system,
		x: 0,
		y: 40,
		summary:
			"The Workflow Builder application database. Committed row changes on the published tables feed the workflow-builder-postgres source via change data capture.",
		configured: [
			{ label: "Role", value: "Observed system — CDC change feed" },
			{ label: "Change capture", value: "PostgreSQL logical replication (configured)" },
			{ label: "Published tables", value: "5 tables" },
		],
		tables: [...POSTGRES_TABLES],
		statusLine: "Observed system (configured)",
		diagnostic:
			"If query inputs look stale, verify the publication and replication slot for workflow-builder-postgres are active and not lagging.",
	},
	{
		id: "sys-kubernetes",
		kind: "system",
		label: "Kubernetes API",
		subtitle: "Cluster state watches",
		accent: ACCENT.system,
		x: 0,
		y: 424,
		summary:
			"The cluster API surface the observer watches. Six resource kinds are reduced to bounded, redacted snapshots before anything is persisted.",
		configured: [
			{ label: "Role", value: "Observed system — API watch stream" },
			{ label: "Watched kinds", value: "6 resource kinds" },
			{ label: "Payload policy", value: "Bounded, redacted snapshots" },
		],
		tables: [...K8S_WATCHED_KINDS],
		statusLine: "Observed system (configured)",
		diagnostic:
			"If observation rows stop arriving, check the observer's watch connections and RBAC grants in the cluster.",
	},
	{
		id: "src-postgres",
		kind: "source",
		label: "workflow-builder-postgres",
		subtitle: "PostgreSQL source",
		accent: ACCENT.source,
		x: 300,
		y: 40,
		summary:
			"Drasi PostgreSQL source over the application database. Continuous queries subscribe to change feeds from its five tables.",
		configured: [
			{ label: "Source kind", value: "PostgreSQL (CDC)" },
			{ label: "Source id", value: "workflow-builder-postgres", mono: true },
			{ label: "Tables", value: "5 published tables" },
		],
		tables: [...POSTGRES_TABLES],
		statusLine: "Readiness: Unavailable",
		diagnostic:
			"Check the source's replication slot lag and connectivity between the Drasi source host and the application database.",
	},
	{
		id: "obs-kubernetes",
		kind: "observer",
		label: "Kubernetes observer",
		subtitle: "Bounded redacted projection",
		accent: ACCENT.observer,
		x: 300,
		y: 340,
		summary:
			"Watches Pods, Events, Deployments, Agent Sandboxes, Kueue Workloads, and Dapr resources, then writes a bounded, redacted projection for Drasi to consume.",
		configured: [
			{ label: "Writes", value: "public.drasi_kubernetes_observations", mono: true },
			{ label: "Also recorded in", value: "gitops_activity_events", mono: true },
			{ label: "Payload policy", value: "Bounded, redacted transitions" },
		],
		tables: [...K8S_WATCHED_KINDS],
		statusLine: UNAVAILABLE_RUNTIME,
		diagnostic:
			"Inspect recent rows in drasi_kubernetes_observations (and gitops_activity_events) for the resource in question before assuming a cluster fault.",
	},
	{
		id: "src-k8s",
		kind: "source",
		label: "workflow-builder-k8s-observations-v2",
		subtitle: "PostgreSQL source",
		accent: ACCENT.source,
		x: 300,
		y: 484,
		summary:
			"Drasi PostgreSQL source over the observer projection table. This is the only path Kubernetes state takes into continuous queries.",
		configured: [
			{ label: "Source kind", value: "PostgreSQL (CDC)" },
			{ label: "Source id", value: "workflow-builder-k8s-observations-v2", mono: true },
			{ label: "Tables", value: "1 projection table" },
		],
		tables: ["drasi_kubernetes_observations"],
		statusLine: "Readiness: Unavailable",
		diagnostic:
			"Confirm the observer is still writing projection rows, then check this source's replication slot and connectivity.",
	},
	{
		id: "workflow-execution-stalled-v2",
		logicalId: "workflow-execution-stalled",
		kind: "query",
		label: "Workflow execution stalled",
		subtitle: "workflow-execution-stalled-v2",
		accent: ACCENT.query,
		x: 620,
		y: 0,
		summary:
			"Fires when a workflow execution makes no progress for ten minutes — the execution row stops updating while it remains in an active state.",
		configured: [
			{ label: "Query id", value: "workflow-execution-stalled-v2", mono: true },
			{ label: "Source", value: "workflow-builder-postgres", mono: true },
			{ label: "Temporal condition", value: "No progress for 10 minutes" },
		],
		tables: ["workflow_executions", "workflow_execution_logs"],
		threshold: "stalled > 10 minutes",
		specExcerpt: {
			language: "cypher",
			code: [
				"MATCH (we:WorkflowExecution)",
				"WHERE we.status IN ['Queued', 'Running']",
				"  AND we.updatedAt < datetime() - duration('PT10M')",
				"RETURN we.id, we.workflowId, we.status, we.updatedAt",
			].join("\n"),
		},
		statusLine: "Status: Unavailable",
		diagnostic:
			"Open the flagged workflow execution and compare its last log timestamp with the stall window before restarting anything.",
	},
	{
		id: "session-failure-storm-v4",
		logicalId: "session-failure-storm",
		kind: "query",
		label: "Session failure storm",
		subtitle: "session-failure-storm-v4",
		accent: ACCENT.query,
		x: 620,
		y: 96,
		summary:
			"Fires when a session accumulates at least three failure events inside a five-minute window — a burst signal rather than a single failure.",
		configured: [
			{ label: "Query id", value: "session-failure-storm-v4", mono: true },
			{ label: "Source", value: "workflow-builder-postgres", mono: true },
			{ label: "Temporal condition", value: "≥ 3 failures within 5 minutes" },
		],
		tables: ["sessions", "session_events"],
		threshold: "≥ 3 failures in 5 minutes",
		specExcerpt: {
			language: "cypher",
			code: [
				"MATCH (se:SessionEvent)-[:OF_SESSION]->(s:Session)",
				"WHERE se.type = 'failure'",
				"  AND se.occurredAt > datetime() - duration('PT5M')",
				"WITH s.id AS sessionId, count(se) AS failures",
				"WHERE failures >= 3",
				"RETURN sessionId, failures",
			].join("\n"),
		},
		statusLine: "Status: Unavailable",
		diagnostic:
			"Group recent session_events failures by session and inspect the first failing event in the burst.",
	},
	{
		id: "sandbox-provisioning-stalled-v3",
		logicalId: "sandbox-provisioning-stalled",
		kind: "query",
		label: "Sandbox provisioning stalled",
		subtitle: "sandbox-provisioning-stalled-v3",
		accent: ACCENT.query,
		x: 620,
		y: 192,
		summary:
			"Fires when an Agent Sandbox stays Pending or Degraded for five minutes — provisioning is stuck rather than merely slow.",
		configured: [
			{ label: "Query id", value: "sandbox-provisioning-stalled-v3", mono: true },
			{ label: "Source", value: "workflow-builder-k8s-observations-v2", mono: true },
			{ label: "Temporal condition", value: "Pending/Degraded for 5 minutes" },
		],
		tables: ["drasi_kubernetes_observations"],
		threshold: "Pending/Degraded > 5 minutes",
		specExcerpt: {
			language: "cypher",
			code: [
				"MATCH (o:K8sObservation {kind: 'AgentSandbox'})",
				"WHERE o.phase IN ['Pending', 'Degraded']",
				"  AND o.observedAt < datetime() - duration('PT5M')",
				"RETURN o.namespace, o.name, o.phase, o.observedAt",
			].join("\n"),
		},
		statusLine: "Status: Unavailable",
		diagnostic:
			"Check the sandbox controller logs and namespace quota for the stuck AgentSandbox.",
	},
	{
		id: "kueue-admission-stalled-v3",
		logicalId: "kueue-admission-stalled",
		kind: "query",
		label: "Kueue admission stalled",
		subtitle: "kueue-admission-stalled-v3",
		accent: ACCENT.query,
		x: 620,
		y: 288,
		summary:
			"Fires when a Kueue Workload remains Pending for five minutes — admission is blocked on quota, ordering, or a missing ClusterQueue.",
		configured: [
			{ label: "Query id", value: "kueue-admission-stalled-v3", mono: true },
			{ label: "Source", value: "workflow-builder-k8s-observations-v2", mono: true },
			{ label: "Temporal condition", value: "Pending for 5 minutes" },
		],
		tables: ["drasi_kubernetes_observations"],
		threshold: "Pending > 5 minutes",
		specExcerpt: {
			language: "cypher",
			code: [
				"MATCH (o:K8sObservation {kind: 'Workload'})",
				"WHERE o.phase = 'Pending'",
				"  AND o.observedAt < datetime() - duration('PT5M')",
				"RETURN o.namespace, o.name, o.queue, o.observedAt",
			].join("\n"),
		},
		statusLine: "Status: Unavailable",
		diagnostic:
			"Inspect the Kueue ClusterQueue admission state and flavor quotas for the pending Workload.",
	},
	{
		id: "dapr-resource-warning-v3",
		logicalId: "dapr-resource-warning",
		kind: "query",
		label: "Dapr resource warning",
		subtitle: "dapr-resource-warning-v3",
		accent: ACCENT.query,
		x: 620,
		y: 384,
		summary:
			"Fires when a dapr.io resource reports Progressing, Warning, or Degraded for two minutes — an early-warning tier below drift.",
		configured: [
			{ label: "Query id", value: "dapr-resource-warning-v3", mono: true },
			{ label: "Source", value: "workflow-builder-k8s-observations-v2", mono: true },
			{ label: "Temporal condition", value: "Progressing/Warning/Degraded for 2 minutes" },
		],
		tables: ["drasi_kubernetes_observations"],
		threshold: "Progressing/Warning/Degraded > 2 minutes",
		specExcerpt: {
			language: "cypher",
			code: [
				"MATCH (o:K8sObservation)",
				"WHERE o.kind STARTS WITH 'dapr.io/'",
				"  AND o.phase IN ['Progressing', 'Warning', 'Degraded']",
				"  AND o.observedAt < datetime() - duration('PT2M')",
				"RETURN o.namespace, o.name, o.phase, o.observedAt",
			].join("\n"),
		},
		statusLine: "Status: Unavailable",
		diagnostic:
			"Read the dapr.io resource conditions for the flagged namespace/name before treating it as drift.",
	},
	{
		id: "dapr-resource-drift-v3",
		logicalId: "dapr-resource-drift",
		kind: "query",
		label: "Dapr resource drift",
		subtitle: "dapr-resource-drift-v3",
		accent: ACCENT.query,
		x: 620,
		y: 480,
		summary:
			"Fires when a dapr.io resource reports Drifted for one minute — live state no longer matches the desired GitOps state.",
		configured: [
			{ label: "Query id", value: "dapr-resource-drift-v3", mono: true },
			{ label: "Source", value: "workflow-builder-k8s-observations-v2", mono: true },
			{ label: "Temporal condition", value: "Drifted for 1 minute" },
		],
		tables: ["drasi_kubernetes_observations"],
		threshold: "Drifted > 1 minute",
		specExcerpt: {
			language: "cypher",
			code: [
				"MATCH (o:K8sObservation)",
				"WHERE o.kind STARTS WITH 'dapr.io/'",
				"  AND o.phase = 'Drifted'",
				"  AND o.observedAt < datetime() - duration('PT1M')",
				"RETURN o.namespace, o.name, o.phase, o.observedAt",
			].join("\n"),
		},
		statusLine: "Status: Unavailable",
		diagnostic:
			"Diff the desired GitOps state with the drifted dapr.io resource; a completed analysis does not prove the drift resolved.",
	},
	{
		id: "react-incident-agent",
		kind: "reaction",
		label: "workflow-builder-incident-agent-v2",
		subtitle: "HTTP reaction",
		accent: ACCENT.reaction,
		x: 960,
		y: 216,
		summary:
			"HTTP reaction that forwards added query results — and only added results — to the Workflow Builder incident ingest endpoint.",
		configured: [
			{ label: "Reaction kind", value: "HTTP" },
			{ label: "Reaction id", value: "workflow-builder-incident-agent-v2", mono: true },
			{ label: "Forwards", value: "Added results only" },
			{ label: "Target", value: "POST /api/internal/drasi/incidents/ingest", mono: true },
		],
		statusLine: "Delivery: Unavailable",
		diagnostic:
			"If incidents stop arriving, check reaction delivery logs and the ingest endpoint's recent responses.",
	},
	{
		id: "wf-incident-analysis",
		kind: "workflow",
		label: "platform-incident-analysis",
		subtitle: "Governed incident workflow",
		accent: ACCENT.workflow,
		x: 1240,
		y: 216,
		summary:
			"Workflow Builder owns the ingest path: validation, correlation, deduplication, and bounded concurrency. It starts platform-incident-analysis with a read-only incident analyst.",
		configured: [
			{ label: "Workflow", value: "platform-incident-analysis", mono: true },
			{ label: "Ingest pipeline", value: "Validate → correlate → deduplicate → bound concurrency" },
			{ label: "Agent", value: "Read-only incident analyst" },
			{ label: "Guarantee", value: "Drasi never mutates the cluster; a completed analysis does not prove the condition resolved" },
		],
		statusLine: "Governed by Workflow Builder",
		diagnostic:
			"Open the incident's workflow execution to review analyst evidence and the tool calls it was allowed to make.",
	},
];

export const DRASI_EDGES: DrasiEdgeSpec[] = [
	{
		id: "e-cdc-postgres",
		source: "sys-postgres",
		target: "src-postgres",
		label: "CDC",
		description:
			"Change-data-capture stream of committed row changes on the five published tables.",
		animated: false,
		diagnostic: "Check publication and replication slot health on the application database.",
	},
	{
		id: "e-watch-k8s",
		source: "sys-kubernetes",
		target: "obs-kubernetes",
		label: "watch",
		description:
			"Watch stream over the six resource kinds, reduced to bounded, redacted snapshots.",
		animated: false,
		diagnostic: "Check the observer's watch connections and RBAC grants.",
	},
	{
		id: "e-projection-rows",
		source: "obs-kubernetes",
		target: "src-k8s",
		label: "projection rows",
		description:
			"Projection rows written to drasi_kubernetes_observations, exposed to Drasi as a PostgreSQL source.",
		animated: false,
		diagnostic: "Confirm the observer is still writing projection rows.",
	},
	{
		id: "e-rows-exec-stalled",
		source: "src-postgres",
		target: "workflow-execution-stalled-v2",
		label: "",
		description: "workflow_executions and workflow_execution_logs change feeds.",
		animated: false,
		diagnostic: "Verify the source is delivering changes for the execution tables.",
	},
	{
		id: "e-rows-failure-storm",
		source: "src-postgres",
		target: "session-failure-storm-v4",
		label: "",
		description: "sessions and session_events change feeds.",
		animated: false,
		diagnostic: "Verify the source is delivering changes for the session tables.",
	},
	{
		id: "e-rows-sandbox",
		source: "src-k8s",
		target: "sandbox-provisioning-stalled-v3",
		label: "",
		description: "AgentSandbox observation rows.",
		animated: false,
		diagnostic: "Verify the projection keeps receiving AgentSandbox transitions.",
	},
	{
		id: "e-rows-kueue",
		source: "src-k8s",
		target: "kueue-admission-stalled-v3",
		label: "",
		description: "Kueue Workload observation rows.",
		animated: false,
		diagnostic: "Verify the projection keeps receiving Workload transitions.",
	},
	{
		id: "e-rows-dapr-warning",
		source: "src-k8s",
		target: "dapr-resource-warning-v3",
		label: "",
		description: "dapr.io resource observation rows.",
		animated: false,
		diagnostic: "Verify the projection keeps receiving dapr.io transitions.",
	},
	{
		id: "e-rows-dapr-drift",
		source: "src-k8s",
		target: "dapr-resource-drift-v3",
		label: "",
		description: "dapr.io resource observation rows.",
		animated: false,
		diagnostic: "Verify the projection keeps receiving dapr.io transitions.",
	},
	{
		id: "e-fire-exec-stalled",
		source: "workflow-execution-stalled-v2",
		target: "react-incident-agent",
		label: "",
		description: "Added results from workflow-execution-stalled-v2.",
		animated: true,
		diagnostic: "Check the query's result stream and the reaction subscription.",
	},
	{
		id: "e-fire-failure-storm",
		source: "session-failure-storm-v4",
		target: "react-incident-agent",
		label: "",
		description: "Added results from session-failure-storm-v4.",
		animated: true,
		diagnostic: "Check the query's result stream and the reaction subscription.",
	},
	{
		id: "e-fire-sandbox",
		source: "sandbox-provisioning-stalled-v3",
		target: "react-incident-agent",
		label: "",
		description: "Added results from sandbox-provisioning-stalled-v3.",
		animated: true,
		diagnostic: "Check the query's result stream and the reaction subscription.",
	},
	{
		id: "e-fire-kueue",
		source: "kueue-admission-stalled-v3",
		target: "react-incident-agent",
		label: "",
		description: "Added results from kueue-admission-stalled-v3.",
		animated: true,
		diagnostic: "Check the query's result stream and the reaction subscription.",
	},
	{
		id: "e-fire-dapr-warning",
		source: "dapr-resource-warning-v3",
		target: "react-incident-agent",
		label: "",
		description: "Added results from dapr-resource-warning-v3.",
		animated: true,
		diagnostic: "Check the query's result stream and the reaction subscription.",
	},
	{
		id: "e-fire-dapr-drift",
		source: "dapr-resource-drift-v3",
		target: "react-incident-agent",
		label: "",
		description: "Added results from dapr-resource-drift-v3.",
		animated: true,
		diagnostic: "Check the query's result stream and the reaction subscription.",
	},
	{
		id: "e-ingest-post",
		source: "react-incident-agent",
		target: "wf-incident-analysis",
		label: "POST ingest",
		description:
			"Added results posted to /api/internal/drasi/incidents/ingest. Workflow Builder validates, correlates, deduplicates, bounds concurrency, and starts platform-incident-analysis with its read-only incident analyst.",
		animated: true,
		diagnostic: "Check the ingest endpoint's recent responses and the reaction's delivery log.",
	},
];

const NODE_INDEX = new Map(DRASI_NODES.map((node) => [node.id, node]));
const EDGE_INDEX = new Map(DRASI_EDGES.map((edge) => [edge.id, edge]));

/**
 * Every query id an incident may carry → canonical physical query id. Ingest
 * persists logical ids (no `-vN` suffix); Drasi itself reports physical ids.
 * Both forms resolve to the same configured query.
 */
const QUERY_ID_ALIASES = new Map<string, string>();
for (const node of DRASI_NODES) {
	if (node.kind !== "query") continue;
	QUERY_ID_ALIASES.set(node.id, node.id);
	if (node.logicalId) QUERY_ID_ALIASES.set(node.logicalId, node.id);
}

export function getNode(id: string): DrasiNodeSpec | null {
	return NODE_INDEX.get(id) ?? null;
}

export function getEdge(id: string): DrasiEdgeSpec | null {
	return EDGE_INDEX.get(id) ?? null;
}

/**
 * Resolve a physical or logical query id to the canonical physical id.
 * Unknown ids pass through unchanged so the UI can still show them verbatim.
 */
export function resolveDrasiQueryId(id: string): string {
	return QUERY_ID_ALIASES.get(id) ?? id;
}

/**
 * Friendly configured name for either query id form, or `null` when the id
 * is not a configured continuous query.
 */
export function drasiQueryName(id: string): string | null {
	const node = getNode(resolveDrasiQueryId(id));
	return node && node.kind === "query" ? node.label : null;
}

/** Queries tab matrix rows, derived from the catalog (configured facts only). */
export function listQueryRows(): DrasiQueryRow[] {
	return DRASI_NODES.filter((node) => node.kind === "query").map((node) => {
		const source = node.configured.find((field) => field.label === "Source");
		const sourceId = source?.value ?? "";
		return {
			id: node.id,
			logicalId: node.logicalId ?? node.id,
			name: node.label,
			sourceId,
			sourceLabel: sourceId,
			condition: node.threshold ?? "",
			tables: node.tables ?? [],
		};
	});
}

/** Data sources tab rows: the two PostgreSQL sources plus the observer. */
export function listSourceRows(): DrasiSourceRow[] {
	const rows: DrasiSourceRow[] = [];
	for (const node of DRASI_NODES) {
		if (node.kind === "source") {
			rows.push({
				nodeId: node.id,
				id: node.label,
				kind: "postgres-source",
				label: node.label,
				subtitle: node.subtitle,
				tables: node.tables ?? [],
				note:
					node.id === "src-k8s"
						? "Transition timestamps are not heartbeats and do not prove CDC freshness."
						: undefined,
			});
		}
		if (node.kind === "observer") {
			rows.push({
				nodeId: node.id,
				id: node.id,
				kind: "k8s-observer",
				label: node.label,
				subtitle: node.subtitle,
				tables: ["drasi_kubernetes_observations", "gitops_activity_events"],
				scope: [...K8S_WATCHED_KINDS],
				note: "Projection rows are bounded and redacted before they are persisted.",
			});
		}
	}
	return rows;
}

export const DRASI_COUNTS = {
	sources: DRASI_NODES.filter((node) => node.kind === "source").length,
	queries: DRASI_NODES.filter((node) => node.kind === "query").length,
	reactions: DRASI_NODES.filter((node) => node.kind === "reaction").length,
};

/**
 * Shared types for the Drasi operations dashboard.
 *
 * Two families live here:
 *  - Static *configured* catalog shapes (nodes/edges/queries) rendered from
 *    `$lib/drasi/catalog.ts` — always available, no runtime required.
 *  - Dynamic *observed* DTOs (incidents, observed status) that must only come
 *    from real API responses. When no runtime is connected these are reported
 *    as `unavailable` — never fabricated.
 */

/** Honesty tri-state for any dynamic value on the dashboard. */
export type DrasiObservedStatus = "observed" | "stale" | "unavailable";

export type DrasiNodeKind =
	| "system"
	| "observer"
	| "source"
	| "query"
	| "reaction"
	| "workflow";

export type DrasiSpecField = {
	label: string;
	value: string;
	/** Render the value in a mono font (ids, table names, paths). */
	mono?: boolean;
};

export type DrasiSpecExcerpt = {
	language: "cypher" | "text";
	/** Short, safe, configured spec excerpt — never a live payload. */
	code: string;
};

/** A node of the configured Drasi causal topology. */
export type DrasiNodeSpec = {
	/** Physical Drasi id (e.g. `workflow-execution-stalled-v2`). */
	id: string;
	kind: DrasiNodeKind;
	label: string;
	subtitle: string;
	/**
	 * Logical id persisted by incident ingest (e.g. `workflow-execution-stalled`)
	 * for continuous queries. Incidents may reference either form; both resolve
	 * to this node's physical id and friendly name.
	 */
	logicalId?: string;
	/** OKLCH accent (dot, left border, tint). Restrained, theme-safe. */
	accent: string;
	/** Fixed canvas position (topology is curated, not auto-laid-out). */
	x: number;
	y: number;
	/** One-line factual description shown in the detail sheet. */
	summary: string;
	/** Configured fields — static facts from the platform contract. */
	configured: DrasiSpecField[];
	/** Source/watched tables or resource kinds, when relevant. */
	tables?: string[];
	/** Human-readable temporal condition for continuous queries. */
	threshold?: string;
	specExcerpt?: DrasiSpecExcerpt;
	/**
	 * Short status phrase rendered on the node. Dynamic health stays
	 * `Unavailable` until a real runtime answer exists.
	 */
	statusLine: string;
	/** Next diagnostic action an operator should take. */
	diagnostic: string;
};

export type DrasiEdgeSpec = {
	id: string;
	source: string;
	target: string;
	/** Short canvas label; empty string renders no label. */
	label: string;
	description: string;
	/** Marching-dash animation for the live signal path. */
	animated: boolean;
	diagnostic: string;
};

/** Selection shared by the canvas, tabs, and detail sheet. */
export type DrasiSelection = { kind: "node"; id: string } | { kind: "edge"; id: string };

/** Row model for the Queries tab matrix. */
export type DrasiQueryRow = {
	/** Physical continuous-query id (also the topology node id). */
	id: string;
	/** Logical query id persisted by incident ingest; aliases `id`. */
	logicalId: string;
	/** Friendly operator-facing name. */
	name: string;
	sourceId: string;
	sourceLabel: string;
	/** Temporal condition, e.g. "stalled > 10 minutes". */
	condition: string;
	tables: string[];
};

/** Row model for the Data sources tab. */
export type DrasiSourceRow = {
	nodeId: string;
	id: string;
	kind: "postgres-source" | "k8s-observer";
	label: string;
	subtitle: string;
	tables: string[];
	scope?: string[];
	note?: string;
};

export type DrasiIncidentSeverity = "critical" | "warning" | "info";

/**
 * One ingested incident as returned by the read API. Every string is bounded
 * and sanitized server-side; the client re-clips defensively.
 */
export type DrasiIncident = {
	id: string;
	correlationId: string;
	/**
	 * Query reference as persisted by ingest: either the physical Drasi id
	 * (`…-vN`) or the logical id. Resolve via `resolveDrasiQueryId` and display
	 * via `drasiQueryName` so both forms filter and render by friendly name.
	 */
	queryId: string;
	severity: DrasiIncidentSeverity;
	title: string;
	occurredAt: string;
	workflowExecutionId: string | null;
	sessionId: string | null;
	/** Bounded evidence snippets (max 3, each pre-clipped). */
	evidence: string[];
};

/** Wire shape of the incident read endpoint. */
export type DrasiIncidentsResponse = {
	incidents: DrasiIncident[];
	truncated: boolean;
};

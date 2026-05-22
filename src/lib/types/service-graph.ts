/**
 * Shared types for the metric-driven service graph (Grafana service-graph style).
 *
 * The graph is reconstructed from telemetry rather than authored:
 *  - `service` mode: nodes are services / DBs / external peers; edges are
 *    client→server (and producer→consumer) span pairs across service boundaries.
 *  - `step` mode: nodes are workflow DAG steps; edges are the authored workflow
 *    edges, but every node/edge carries RED metrics (rate / errors / duration).
 *
 * Kept framework-free (no `@xyflow` imports) so the BFF can import it too.
 */

export type ServiceGraphMode = 'service' | 'step';
export type ServiceGraphScope = 'execution' | 'window';

/** Allowed rolling-window selections for `scope=window`. */
export type ServiceGraphWindow = '5m' | '15m' | '1h' | '6h' | '24h';

export const SERVICE_GRAPH_WINDOWS: Record<ServiceGraphWindow, number> = {
	'5m': 300,
	'15m': 900,
	'1h': 3600,
	'6h': 21600,
	'24h': 86400
};

/**
 * RED metrics for a node or edge.
 * - `total`: raw request/invocation count contributing to this entity.
 * - `errors`: count where the span/step status was an error.
 * - `errorRate`: errors / total (0..1) — drives edge/node color.
 * - `rate`: requests per second (windowed) or === `total` (single execution).
 * - `p50/p95/p99`: latency percentiles in milliseconds.
 * - `selfMs` (nodes only): self/own latency in milliseconds (median of the
 *   entity's own spans / sum of step execution time).
 */
export interface RedMetrics {
	total: number;
	errors: number;
	errorRate: number;
	rate: number;
	p50: number;
	p95: number;
	p99: number;
	selfMs?: number;
}

export type ServiceGraphNodeKind = 'service' | 'db' | 'external' | 'user' | 'step';

export interface ServiceGraphNode {
	/** Stable id: serviceName, virtual peer key (`db:postgres`), or workflow nodeId. */
	id: string;
	label: string;
	kind: ServiceGraphNodeKind;
	/** Worst observed status across contributing spans/steps — drives the node ring. */
	status: 'ok' | 'error' | 'idle';
	red: RedMetrics;
}

export interface ServiceGraphEdge {
	/** `${source}__${target}`. */
	id: string;
	source: string;
	target: string;
	red: RedMetrics;
}

export interface ServiceGraphMeta {
	spanCount: number;
	traceCount: number;
	/** True when the underlying store was unreachable/empty — graph may be partial. */
	degraded?: boolean;
	/** True once the edge `LIMIT` truncated the result. */
	truncated?: boolean;
	warnings: string[];
}

export interface ServiceGraphPayload {
	mode: ServiceGraphMode;
	scope: ServiceGraphScope;
	/** Present when scope === 'window'. */
	windowSeconds?: number;
	/** Present when scope === 'execution'. */
	executionId?: string;
	/** Present when narrowed by workflow (required for step + window). */
	workflowId?: string;
	nodes: ServiceGraphNode[];
	edges: ServiceGraphEdge[];
	meta: ServiceGraphMeta;
	/** Per-node/edge insight overlays + critical path (execution scope only). */
	insights?: ServiceGraphInsights;
}

// ---------------------------------------------------------------------------
// Selection (click a node or edge to drill in)
// ---------------------------------------------------------------------------

export type GraphSelection =
	| { kind: 'node'; id: string; nodeKind: ServiceGraphNodeKind }
	| { kind: 'edge'; id: string; source: string; target: string };

/** `node:<id>` or `edge:<source>__<target>`. nodeKind rides in a separate query param. */
export function serializeSelection(sel: GraphSelection): string {
	return sel.kind === 'node' ? `node:${sel.id}` : `edge:${sel.source}__${sel.target}`;
}

export function parseSelection(
	raw: string | null | undefined,
	nodeKind?: string | null
): GraphSelection | null {
	if (!raw) return null;
	if (raw.startsWith('node:')) {
		const id = raw.slice(5);
		if (!id) return null;
		return { kind: 'node', id, nodeKind: (nodeKind as ServiceGraphNodeKind) ?? 'service' };
	}
	if (raw.startsWith('edge:')) {
		const rest = raw.slice(5);
		const idx = rest.indexOf('__');
		if (idx < 0) return null;
		const source = rest.slice(0, idx);
		const target = rest.slice(idx + 2);
		if (!source || !target) return null;
		return { kind: 'edge', id: rest, source, target };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Insight overlays
// ---------------------------------------------------------------------------

export interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheCreate: number;
	total: number;
}

export interface TimingBreakdown {
	coldStartMs: number;
	routingMs: number;
	credentialFetchMs: number;
	executionMs: number;
	wasColdStart: boolean;
}

export interface ErrorSample {
	message: string;
	spanId?: string;
	traceId?: string;
}

export interface NodeInsight {
	tokens?: TokenTotals;
	costUsd?: number;
	timing?: TimingBreakdown;
	workflowActivity?: {
		correlationIds: string[];
		daprTaskIds: string[];
		relatedSpanIds: string[];
		servicesTouched: string[];
	};
	/** Attempts beyond the first (retries). */
	retries?: number;
	errorSamples?: ErrorSample[];
}

export interface ServiceGraphInsights {
	nodes: Record<string, NodeInsight>;
	edges: Record<string, NodeInsight>;
	/** Ordered node ids on the slowest end-to-end path. */
	criticalPath?: string[];
}

/** Parsed, validated query for `buildServiceGraph`. */
export interface ServiceGraphQuery {
	mode: ServiceGraphMode;
	scope: ServiceGraphScope;
	executionId?: string;
	workflowId?: string;
	windowSeconds: number;
}

/** Convenience: an empty (degraded or no-data) payload. */
export function emptyServiceGraph(
	query: Pick<ServiceGraphQuery, 'mode' | 'scope' | 'executionId' | 'workflowId' | 'windowSeconds'>,
	meta: Partial<ServiceGraphMeta> = {}
): ServiceGraphPayload {
	return {
		mode: query.mode,
		scope: query.scope,
		windowSeconds: query.scope === 'window' ? query.windowSeconds : undefined,
		executionId: query.scope === 'execution' ? query.executionId : undefined,
		workflowId: query.workflowId,
		nodes: [],
		edges: [],
		meta: { spanCount: 0, traceCount: 0, warnings: [], ...meta }
	};
}

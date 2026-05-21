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

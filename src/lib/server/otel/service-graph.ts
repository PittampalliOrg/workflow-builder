/**
 * Metric-driven service-graph aggregation (Grafana service-graph style).
 *
 * Grafana derives its service graph from a `servicegraph` connector that emits
 * `traces_service_graph_request_*` Prometheus metrics. We have no such connector,
 * so we reconstruct the same RED (rate/errors/duration) topology directly from the
 * raw spans we already store in ClickHouse (`otel.otel_traces`) plus, for the
 * workflow-step view, the per-node `workflow_execution_logs` table.
 *
 * Four combinations are supported (mode × scope):
 *   service × execution  — pair client→server spans within one run's trace set
 *   service × window     — same pairing as a ClickHouse self-join over a window
 *   step    × execution  — workflow DAG + per-node logs for one run
 *   step    × window     — workflow DAG + aggregated logs across recent runs
 *
 * IMPORTANT literal notes (verified against live data, NOT the OTLP enum names):
 *   - SpanKind values are 'Client' | 'Server' | 'Producer' | 'Consumer' | 'Internal'.
 *   - StatusCode values are 'Unset' | 'Ok' | 'Error'.
 */
import type { ObservabilityTraceSpan } from '$lib/types/observability';
import {
	CLICKHOUSE_DB,
	escapeClickHouseString,
	extractExecutionTraceIds,
	findCorrelatedTraceIds,
	getMultiTraceGraphLlmSpans,
	getMultiTraceSpanSummaries,
	queryClickHouse,
	sanitizeTraceIds,
	type GraphLlmSpan,
	type TraceTimeWindow
} from '$lib/server/otel/clickhouse';
import { costFor } from '$lib/server/pricing/model-pricing';
import {
	emptyServiceGraph,
	type NodeInsight,
	type RedMetrics,
	type ServiceGraphEdge,
	type ServiceGraphInsights,
	type ServiceGraphMode,
	type ServiceGraphNode,
	type ServiceGraphNodeKind,
	type ServiceGraphPayload,
	type ServiceGraphQuery
} from '$lib/types/service-graph';

const MAX_TRACE_IDS = 200;
const EDGE_LIMIT = 500;
const CLIENT_KINDS = new Set(['Client', 'Producer']);
const SERVER_KINDS = new Set(['Server', 'Consumer']);
const ERROR_STATUS = 'Error';

export type ServiceGraphExecutionContext = {
	id: string;
	output: unknown;
	primaryTraceId: string | null;
	workflowSessionId: string | null;
	startedAt: Date;
	completedAt: Date | null;
};

export type ServiceGraphWorkflowContext = {
	id: string;
	nodes: unknown[];
	edges: unknown[];
};

export type ServiceGraphStepLogRow = {
	nodeId: string;
	status: string;
	duration: string | number | null;
	executionMs: number | null;
	credentialFetchMs: number | null;
	routingMs: number | null;
	coldStartMs: number | null;
	wasColdStart: boolean | null;
};

export function isBenignControlPlaneError(span: ObservabilityTraceSpan): boolean {
	if (span.statusCode !== ERROR_STATUS) return false;
	const operation = span.operationName || '';
	const message = span.statusMessage || '';
	if (operation.includes('SubscribeTopicEventsAlpha1') && message.includes('context canceled')) {
		return true;
	}
	if (
		operation.includes('GetConfiguration') &&
		message.includes('configuration stores not configured')
	) {
		return true;
	}
	if (
		span.serviceName === 'workflow-builder' &&
		span.spanKind === 'Client' &&
		operation.startsWith('DELETE ') &&
		!message
	) {
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// small numeric helpers
// ---------------------------------------------------------------------------

function toNum(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

/** Nearest-rank percentiles over an unsorted millisecond array. */
function percentiles(values: number[]): {
	p50: number;
	p95: number;
	p99: number;
} {
	if (values.length === 0) return { p50: 0, p95: 0, p99: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number) => {
		const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
		return Math.round(sorted[idx] * 10) / 10;
	};
	return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}

/**
 * Per-agent runtime pods publish a distinct `service.name` per session
 * (`agent-session-<20hex>`). Collapse them into one topology node so the graph
 * stays readable; the per-session detail lives in the existing trace explorer.
 */
export function collapseServiceName(name: string): string {
	return name.replace(/^agent-session-[0-9a-f]{8,}$/i, 'agent-session');
}

// ---------------------------------------------------------------------------
// graph accumulator shared by all builders
// ---------------------------------------------------------------------------

interface NodeAcc {
	id: string;
	label: string;
	kind: ServiceGraphNodeKind;
	total: number;
	errors: number;
	durations: number[];
	selfDurations: number[];
	status: 'ok' | 'error' | 'idle';
}

interface EdgeAcc {
	source: string;
	target: string;
	total: number;
	errors: number;
	durations: number[];
}

class GraphBuilder {
	private nodes = new Map<string, NodeAcc>();
	private edges = new Map<string, EdgeAcc>();

	node(id: string, kind: ServiceGraphNodeKind, label = id): NodeAcc {
		let n = this.nodes.get(id);
		if (!n) {
			n = {
				id,
				label,
				kind,
				total: 0,
				errors: 0,
				durations: [],
				selfDurations: [],
				status: 'idle'
			};
			this.nodes.set(id, n);
		}
		return n;
	}

	edge(source: string, target: string): EdgeAcc {
		const key = `${source}__${target}`;
		let e = this.edges.get(key);
		if (!e) {
			e = { source, target, total: 0, errors: 0, durations: [] };
			this.edges.set(key, e);
		}
		return e;
	}

	finalize(perSecond: number | null): {
		nodes: ServiceGraphNode[];
		edges: ServiceGraphEdge[];
	} {
		const mkRed = (
			total: number,
			errors: number,
			durations: number[],
			selfMs?: number
		): RedMetrics => {
			const pct = percentiles(durations);
			return {
				total,
				errors,
				errorRate: total > 0 ? errors / total : 0,
				rate: perSecond ? total / perSecond : total,
				...pct,
				...(selfMs != null ? { selfMs } : {})
			};
		};

		const nodes: ServiceGraphNode[] = [...this.nodes.values()].map((n) => ({
			id: n.id,
			label: n.label,
			kind: n.kind,
			status: n.status,
			red: mkRed(
				n.total,
				n.errors,
				n.durations,
				n.selfDurations.length ? percentiles(n.selfDurations).p50 : undefined
			)
		}));

		const edges: ServiceGraphEdge[] = [...this.edges.values()]
			.filter((e) => e.source !== e.target)
			.map((e) => ({
				id: `${e.source}__${e.target}`,
				source: e.source,
				target: e.target,
				red: mkRed(e.total, e.errors, e.durations)
			}));

		return { nodes, edges };
	}
}

// ---------------------------------------------------------------------------
// trace-set resolution for single-execution service view
// ---------------------------------------------------------------------------

type ExecutionRow = ServiceGraphExecutionContext;

/** Trace ids tagged with this execution id via the `workflow.execution.id` span attr. */
function executionTimestampWindow(execution: ExecutionRow): string {
	const start = new Date(execution.startedAt.getTime() - 5_000)
		.toISOString()
		.replace('T', ' ')
		.replace('Z', '');
	const end = new Date((execution.completedAt?.getTime() ?? Date.now()) + 10_000)
		.toISOString()
		.replace('T', ' ')
		.replace('Z', '');
	return `AND Timestamp >= '${start}' AND Timestamp <= '${end}'`;
}

async function traceIdsByExecutionAttr(
	executionId: string,
	execution: ExecutionRow
): Promise<string[]> {
	const escaped = escapeClickHouseString(executionId.trim());
	if (!escaped) return [];
	const rows = await queryClickHouse(`
		SELECT DISTINCT TraceId FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE (
			(mapContains(SpanAttributes, 'workflow.execution.id') AND SpanAttributes['workflow.execution.id'] = '${escaped}')
			OR (mapContains(SpanAttributes, 'session.id') AND SpanAttributes['session.id'] = '${escaped}')
		)
		${executionTimestampWindow(execution)}
		ORDER BY TraceId`);
	return sanitizeTraceIds(rows.map((r) => String(r.TraceId ?? '')));
}

export async function resolveExecutionTraceIds(execution: ExecutionRow): Promise<string[]> {
	const ids = new Set<string>();
	if (execution.primaryTraceId) ids.add(execution.primaryTraceId.trim());
	for (const id of extractExecutionTraceIds(execution.output)) ids.add(id);
	try {
		const correlationIds = new Set(
			[execution.id, execution.workflowSessionId]
				.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
				.map((id) => id.trim())
		);
		for (const correlationId of correlationIds) {
			for (const id of await traceIdsByExecutionAttr(correlationId, execution)) ids.add(id);
		}
	} catch (err) {
		console.warn('[service-graph] Trace id attribute lookup failed', {
			executionId: execution.id,
			message: err instanceof Error ? err.message : String(err)
		});
	}

	let resolved = sanitizeTraceIds([...ids]);
	if (resolved.length === 0) {
		// Last resort: services that don't propagate context across Dapr boundaries.
		const correlated = await findCorrelatedTraceIds(
			execution.startedAt,
			execution.completedAt,
			resolved
		);
		resolved = sanitizeTraceIds(correlated);
	}
	return resolved.slice(0, MAX_TRACE_IDS);
}

// ---------------------------------------------------------------------------
// combo 1 — service × execution (from in-memory spans)
// ---------------------------------------------------------------------------

function isError(span: ObservabilityTraceSpan): boolean {
	return span.statusCode === ERROR_STATUS && !isBenignControlPlaneError(span);
}

export function virtualPeer(
	span: ObservabilityTraceSpan
): { id: string; kind: ServiceGraphNodeKind; label: string } | null {
	const attrs = span.attributes ?? {};
	const dbSystem = attrs['db.system.name'] ?? attrs['db.system'] ?? attrs['db.namespace'];
	if (dbSystem)
		return {
			id: `db:${String(dbSystem)}`,
			kind: 'db',
			label: String(dbSystem)
		};
	const peer = attrs['peer.service'] ?? attrs['server.address'] ?? attrs['net.peer.name'];
	if (peer) return { id: `ext:${String(peer)}`, kind: 'external', label: String(peer) };
	return null;
}

export function buildServiceGraphFromSpans(spans: ObservabilityTraceSpan[]): {
	nodes: ServiceGraphNode[];
	edges: ServiceGraphEdge[];
} {
	const g = new GraphBuilder();
	const byId = new Map(spans.map((s) => [s.spanId, s]));
	// Children grouped by parent for client→server pairing.
	const childrenOf = new Map<string, ObservabilityTraceSpan[]>();
	for (const s of spans) {
		if (s.parentSpanId) {
			const list = childrenOf.get(s.parentSpanId) ?? [];
			list.push(s);
			childrenOf.set(s.parentSpanId, list);
		}
	}

	for (const span of spans) {
		const svc = collapseServiceName(span.serviceName);
		const node = g.node(svc, 'service');
		if (span.spanKind === 'Internal') node.selfDurations.push(span.duration);

		// CLIENT/PRODUCER → find a child SERVER/CONSUMER span in a different service.
		if (span.spanKind && CLIENT_KINDS.has(span.spanKind)) {
			const kids = (childrenOf.get(span.spanId) ?? []).filter(
				(c) => c.spanKind && SERVER_KINDS.has(c.spanKind)
			);
			const crossService = kids.filter((c) => collapseServiceName(c.serviceName) !== svc);
			if (crossService.length > 0) {
				for (const child of crossService) {
					const dst = collapseServiceName(child.serviceName);
					g.node(dst, 'service');
					const e = g.edge(svc, dst);
					e.total += 1;
					const err = isError(span) || isError(child);
					if (err) e.errors += 1;
					e.durations.push(child.duration || span.duration);
				}
			} else if (kids.length === 0) {
				// No in-set server child → uninstrumented peer (DB / external).
				const peer = virtualPeer(span);
				if (peer) {
					g.node(peer.id, peer.kind, peer.label);
					const e = g.edge(svc, peer.id);
					e.total += 1;
					if (isError(span)) e.errors += 1;
					e.durations.push(span.duration);
				}
			}
		}

		// SERVER/CONSUMER whose parent is outside the fetched set → external `user` entry.
		if (span.spanKind && SERVER_KINDS.has(span.spanKind)) {
			const parentInSet = span.parentSpanId ? byId.has(span.parentSpanId) : false;
			if (!parentInSet) {
				g.node('user', 'user', 'user');
				const e = g.edge('user', svc);
				e.total += 1;
				if (isError(span)) e.errors += 1;
				e.durations.push(span.duration);
			}
		}
	}

	// Roll edge stats up into target-node incoming totals + status.
	const built = g.finalize(null);
	const nodeIndex = new Map(built.nodes.map((n) => [n.id, n]));
	for (const e of built.edges) {
		const target = nodeIndex.get(e.target);
		if (target) {
			target.red.total += e.red.total;
			target.red.errors += e.red.errors;
			target.red.errorRate = target.red.total > 0 ? target.red.errors / target.red.total : 0;
			target.red.rate = target.red.total;
			if (e.red.errors > 0) target.status = 'error';
			else if (target.status === 'idle') target.status = 'ok';
		}
	}
	return built;
}

// ---------------------------------------------------------------------------
// combo 2 — service × window (ClickHouse self-join)
// ---------------------------------------------------------------------------

async function buildServiceGraphWindowed(
	windowSeconds: number,
	workflowId: string | undefined
): Promise<{
	nodes: ServiceGraphNode[];
	edges: ServiceGraphEdge[];
	truncated: boolean;
}> {
	const wfFilter = workflowId
		? `AND SpanAttributes['workflow.id'] = '${escapeClickHouseString(workflowId)}'`
		: '';
	const since = `now() - INTERVAL ${Math.floor(windowSeconds)} SECOND`;

	// Edges: client→server pairing across services.
	const edgeRows = await queryClickHouse(`
		WITH client AS (
			SELECT SpanId, ServiceName src, Duration/1000000 ms, StatusCode
			FROM ${CLICKHOUSE_DB}.otel_traces
			WHERE Timestamp >= ${since} AND SpanKind IN ('Client','Producer') ${wfFilter}
		),
		server AS (
			SELECT ParentSpanId, ServiceName dst, Duration/1000000 ms, StatusCode
			FROM ${CLICKHOUSE_DB}.otel_traces
			WHERE Timestamp >= ${since} AND SpanKind IN ('Server','Consumer') ${wfFilter}
		)
		SELECT c.src source, s.dst target, count() total,
			countIf(c.StatusCode='${ERROR_STATUS}' OR s.StatusCode='${ERROR_STATUS}') errors,
			quantile(0.5)(s.ms) p50, quantile(0.95)(s.ms) p95, quantile(0.99)(s.ms) p99
		FROM client c INNER JOIN server s ON s.ParentSpanId = c.SpanId
		WHERE c.src != s.dst
		GROUP BY source, target HAVING total > 0
		ORDER BY total DESC LIMIT ${EDGE_LIMIT + 1}`);

	// DB edges: client spans carrying stable db.system.name or legacy db.system
	// → virtual db node (uninstrumented).
	const dbRows = await queryClickHouse(`
		SELECT ServiceName source,
			if(
				mapContains(SpanAttributes, 'db.system.name') AND SpanAttributes['db.system.name'] != '',
				SpanAttributes['db.system.name'],
				SpanAttributes['db.system']
			) db,
			count() total,
			countIf(StatusCode='${ERROR_STATUS}') errors,
			quantile(0.5)(Duration/1000000) p50, quantile(0.95)(Duration/1000000) p95, quantile(0.99)(Duration/1000000) p99
		FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE Timestamp >= ${since} AND SpanKind IN ('Client','Producer')
			AND (
				(mapContains(SpanAttributes, 'db.system.name') AND SpanAttributes['db.system.name'] != '')
				OR (mapContains(SpanAttributes, 'db.system') AND SpanAttributes['db.system'] != '')
			) ${wfFilter}
		GROUP BY source, db ORDER BY total DESC LIMIT 100`);

	// User-entry edges: root server spans (no parent) → instrumented service.
	const userRows = await queryClickHouse(`
		SELECT ServiceName target, count() total,
			countIf(StatusCode='${ERROR_STATUS}') errors,
			quantile(0.5)(Duration/1000000) p50, quantile(0.95)(Duration/1000000) p95, quantile(0.99)(Duration/1000000) p99
		FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE Timestamp >= ${since} AND SpanKind IN ('Server','Consumer')
			AND (ParentSpanId = '' OR ParentSpanId IS NULL) ${wfFilter}
		GROUP BY target ORDER BY total DESC LIMIT 100`);

	// Node self-latency from each service's Internal spans.
	const selfRows = await queryClickHouse(`
		SELECT ServiceName service, count() total,
			countIf(StatusCode='${ERROR_STATUS}') errors,
			quantile(0.5)(Duration/1000000) selfMs
		FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE Timestamp >= ${since} AND SpanKind = 'Internal' ${wfFilter}
		GROUP BY service`);

	const truncated = edgeRows.length > EDGE_LIMIT;
	const nodes = new Map<string, ServiceGraphNode>();
	const ensure = (id: string, kind: ServiceGraphNodeKind, label = id): ServiceGraphNode => {
		let n = nodes.get(id);
		if (!n) {
			n = {
				id,
				label,
				kind,
				status: 'idle',
				red: {
					total: 0,
					errors: 0,
					errorRate: 0,
					rate: 0,
					p50: 0,
					p95: 0,
					p99: 0
				}
			};
			nodes.set(id, n);
		}
		return n;
	};
	const mkEdge = (
		source: string,
		target: string,
		row: Record<string, unknown>
	): ServiceGraphEdge => {
		const total = toNum(row.total);
		const errors = toNum(row.errors);
		const tgt = ensure(target, nodes.get(target)?.kind ?? 'service');
		tgt.red.total += total;
		tgt.red.errors += errors;
		tgt.red.errorRate = tgt.red.total > 0 ? tgt.red.errors / tgt.red.total : 0;
		tgt.red.rate = tgt.red.total / windowSeconds;
		if (errors > 0) tgt.status = 'error';
		else if (tgt.status === 'idle') tgt.status = 'ok';
		return {
			id: `${source}__${target}`,
			source,
			target,
			red: {
				total,
				errors,
				errorRate: total > 0 ? errors / total : 0,
				rate: total / windowSeconds,
				p50: Math.round(toNum(row.p50) * 10) / 10,
				p95: Math.round(toNum(row.p95) * 10) / 10,
				p99: Math.round(toNum(row.p99) * 10) / 10
			}
		};
	};

	const edges: ServiceGraphEdge[] = [];
	for (const row of edgeRows.slice(0, EDGE_LIMIT)) {
		const source = collapseServiceName(String(row.source));
		const target = collapseServiceName(String(row.target));
		if (source === target) continue;
		ensure(source, 'service');
		ensure(target, 'service');
		edges.push(mkEdge(source, target, row));
	}
	for (const row of dbRows) {
		const source = collapseServiceName(String(row.source));
		const dbId = `db:${String(row.db)}`;
		ensure(source, 'service');
		ensure(dbId, 'db', String(row.db));
		edges.push(mkEdge(source, dbId, row));
	}
	for (const row of userRows) {
		const target = collapseServiceName(String(row.target));
		ensure('user', 'user', 'user');
		ensure(target, 'service');
		edges.push(mkEdge('user', target, row));
	}
	for (const row of selfRows) {
		const id = collapseServiceName(String(row.service));
		const n = ensure(id, 'service');
		n.red.selfMs = Math.round(toNum(row.selfMs) * 10) / 10;
	}

	// Merge duplicate edges produced by collapsed service names.
	const merged = new Map<string, ServiceGraphEdge>();
	for (const e of edges) {
		if (e.source === e.target) continue;
		const existing = merged.get(e.id);
		if (!existing) {
			merged.set(e.id, e);
		} else {
			existing.red.total += e.red.total;
			existing.red.errors += e.red.errors;
			existing.red.errorRate =
				existing.red.total > 0 ? existing.red.errors / existing.red.total : 0;
			existing.red.rate = existing.red.total / windowSeconds;
			existing.red.p50 = Math.max(existing.red.p50, e.red.p50);
			existing.red.p95 = Math.max(existing.red.p95, e.red.p95);
			existing.red.p99 = Math.max(existing.red.p99, e.red.p99);
		}
	}

	return { nodes: [...nodes.values()], edges: [...merged.values()], truncated };
}

// ---------------------------------------------------------------------------
// step view shared: workflow DAG → graph skeleton
// ---------------------------------------------------------------------------

interface WorkflowNodeJson {
	id: string;
	type?: string;
	data?: Record<string, unknown>;
}
interface WorkflowEdgeJson {
	id?: string;
	source: string;
	target: string;
}

function nodeLabel(node: WorkflowNodeJson): string {
	const data = node.data ?? {};
	return (
		(typeof data.label === 'string' && data.label) ||
		(typeof data.name === 'string' && data.name) ||
		node.type ||
		node.id
	);
}

// ---------------------------------------------------------------------------
// combo 3 — step × execution (workflow_execution_logs for one run)
// ---------------------------------------------------------------------------

async function buildStepGraphSingleExec(
	workflow: ServiceGraphWorkflowContext,
	logs: ServiceGraphStepLogRow[]
): Promise<{
	nodes: ServiceGraphNode[];
	edges: ServiceGraphEdge[];
	logs: StepLogRow[];
}> {
	const wfNodes = (workflow.nodes ?? []) as WorkflowNodeJson[];
	const wfEdges = (workflow.edges ?? []) as WorkflowEdgeJson[];

	const byNode = new Map<string, typeof logs>();
	for (const log of logs) {
		const list = byNode.get(log.nodeId) ?? [];
		list.push(log);
		byNode.set(log.nodeId, list);
	}

	const nodes: ServiceGraphNode[] = wfNodes.map((wn) => {
		const rows = byNode.get(wn.id) ?? [];
		const total = rows.length;
		const errors = rows.filter((r) => r.status === 'error').length;
		const durations = rows.map((r) => toNum(r.duration)).filter((d) => d > 0);
		const selfMs = rows.reduce((acc, r) => acc + toNum(r.executionMs ?? r.duration), 0);
		const status: ServiceGraphNode['status'] = total === 0 ? 'idle' : errors > 0 ? 'error' : 'ok';
		return {
			id: wn.id,
			label: nodeLabel(wn),
			kind: 'step',
			status,
			red: {
				total,
				errors,
				errorRate: total > 0 ? errors / total : 0,
				rate: total,
				...percentiles(durations),
				selfMs
			}
		};
	});
	const nodeIndex = new Map(nodes.map((n) => [n.id, n]));

	const edges: ServiceGraphEdge[] = [];
	for (const we of wfEdges) {
		if (!nodeIndex.has(we.source) || !nodeIndex.has(we.target) || we.source === we.target) continue;
		const src = nodeIndex.get(we.source)!;
		const tgt = nodeIndex.get(we.target)!;
		const fired = src.red.total > 0 && tgt.red.total > 0;
		edges.push({
			id: `${we.source}__${we.target}`,
			source: we.source,
			target: we.target,
			red: {
				total: fired ? Math.min(src.red.total, tgt.red.total) : 0,
				errors: src.red.errors,
				errorRate: src.red.errorRate,
				rate: fired ? Math.min(src.red.total, tgt.red.total) : 0,
				p50: tgt.red.p50,
				p95: tgt.red.p95,
				p99: tgt.red.p99
			}
		});
	}
	return { nodes, edges, logs };
}

// ---------------------------------------------------------------------------
// combo 3b — step × execution for DYNAMIC-SCRIPT runs (workflow_script_calls)
// ---------------------------------------------------------------------------

/** Journal row subset the route passes in for dynamic-script executions. */
export type ServiceGraphScriptCallRow = {
	callId: string;
	seq: number;
	kind: string;
	label: string | null;
	phase: string | null;
	status: string;
	sessionId: string | null;
	retries: number;
	errorCode: string | null;
};

/**
 * Build the step graph for a dynamic-script execution from its call journal.
 * The script's spec is JS (no SW `do` graph), so steps = journal calls grouped
 * into phase lanes: every call in phase i feeds every call in phase i+1 (the
 * script's dataflow — later phases consume earlier results). Per-call RED is
 * derived from the run's spans via the deterministic child `session.id`
 * attribute; tokens/cost from LLM spans by sessionId.
 */
export function buildStepGraphDynamicScript(
	calls: ServiceGraphScriptCallRow[],
	spans: ObservabilityTraceSpan[],
	llmSpans: GraphLlmSpan[]
): {
	nodes: ServiceGraphNode[];
	edges: ServiceGraphEdge[];
	insights: ServiceGraphInsights;
} {
	const ordered = [...calls].sort((a, b) => a.seq - b.seq);

	// Per-session span windows → per-call durations/errors.
	const spanAgg = new Map<string, { startMs: number; endMs: number; errors: number }>();
	for (const s of spans) {
		const sessionId = s.attributes?.['session.id'];
		if (!sessionId) continue;
		const key = String(sessionId);
		const start = Date.parse(s.startTime);
		if (!Number.isFinite(start)) continue;
		const end = start + (s.duration || 0);
		const agg = spanAgg.get(key) ?? {
			startMs: Infinity,
			endMs: -Infinity,
			errors: 0
		};
		agg.startMs = Math.min(agg.startMs, start);
		agg.endMs = Math.max(agg.endMs, end);
		if (isError(s)) agg.errors += 1;
		spanAgg.set(key, agg);
	}

	const nodes: ServiceGraphNode[] = ordered.map((call) => {
		const agg = call.sessionId ? spanAgg.get(call.sessionId) : undefined;
		const durationMs =
			agg && Number.isFinite(agg.startMs) && agg.endMs > agg.startMs ? agg.endMs - agg.startMs : 0;
		const failed = call.status === 'error';
		const live = call.status === 'running';
		const attempts = 1 + Math.max(0, call.retries);
		return {
			id: call.callId,
			label: call.label || `${call.kind} #${call.seq + 1}`,
			kind: 'step',
			status: failed ? 'error' : live || call.status === 'done' ? 'ok' : 'idle',
			group: call.phase ?? null,
			detail: call.kind || 'agent',
			live,
			sessionId: call.sessionId ?? null,
			red: {
				total: attempts,
				errors: failed ? 1 : 0,
				errorRate: failed ? 1 / attempts : 0,
				rate: attempts,
				p50: durationMs,
				p95: durationMs,
				p99: durationMs,
				selfMs: durationMs
			}
		};
	});

	// Phase lanes in first-seen (seq) order; unphased calls form their own lane.
	const laneOf = (c: ServiceGraphScriptCallRow) => c.phase ?? '__unphased__';
	const laneOrder: string[] = [];
	const byLane = new Map<string, ServiceGraphScriptCallRow[]>();
	for (const c of ordered) {
		const lane = laneOf(c);
		if (!byLane.has(lane)) {
			byLane.set(lane, []);
			laneOrder.push(lane);
		}
		byLane.get(lane)!.push(c);
	}

	const nodeIndex = new Map(nodes.map((n) => [n.id, n]));
	const edges: ServiceGraphEdge[] = [];
	const MAX_LANE_EDGES = 32;
	for (let i = 0; i + 1 < laneOrder.length; i++) {
		const from = byLane.get(laneOrder[i])!;
		const to = byLane.get(laneOrder[i + 1])!;
		if (from.length * to.length > MAX_LANE_EDGES) {
			// Fan-out too wide to draw fully — connect first of each pair so the
			// lane ordering still reads; the phase hue carries the grouping.
			const src = from[0];
			const tgt = to[0];
			if (src && tgt) {
				edges.push(dynamicEdge(src.callId, tgt.callId, nodeIndex));
			}
			continue;
		}
		for (const src of from) {
			for (const tgt of to) {
				edges.push(dynamicEdge(src.callId, tgt.callId, nodeIndex));
			}
		}
	}

	// Insights: tokens/cost per call via the LLM spans' sessionId; retries +
	// error samples straight from the journal.
	const nodeInsights: Record<string, NodeInsight> = {};
	const ensure = (id: string): NodeInsight => (nodeInsights[id] ??= {});
	const callBySession = new Map(
		ordered.filter((c) => c.sessionId).map((c) => [c.sessionId as string, c])
	);
	for (const s of llmSpans) {
		const call = s.sessionId ? callBySession.get(s.sessionId) : undefined;
		if (!call) continue;
		const ins = ensure(call.callId);
		const t = (ins.tokens ??= {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheCreate: 0,
			total: 0
		});
		const inputTokens = s.promptTokens ?? 0;
		const outputTokens = s.completionTokens ?? 0;
		const cacheReadTokens = s.cacheReadInputTokens ?? 0;
		const cacheCreateTokens = s.cacheCreationInputTokens ?? 0;
		t.input += inputTokens;
		t.output += outputTokens;
		t.cacheRead += cacheReadTokens;
		t.cacheCreate += cacheCreateTokens;
		t.total += s.totalTokens ?? inputTokens + outputTokens;
		ins.costUsd =
			(ins.costUsd ?? 0) +
			costFor(s.modelName, {
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheCreateTokens
			});
	}
	for (const call of ordered) {
		if (call.retries > 0) ensure(call.callId).retries = call.retries;
		if (call.errorCode) {
			(ensure(call.callId).errorSamples ??= []).push({
				message: call.errorCode
			});
		}
	}

	return {
		nodes,
		edges,
		insights: {
			nodes: nodeInsights,
			edges: {},
			criticalPath: computeCriticalPath(nodes, edges)
		}
	};
}

function dynamicEdge(
	source: string,
	target: string,
	nodeIndex: Map<string, ServiceGraphNode>
): ServiceGraphEdge {
	const tgt = nodeIndex.get(target);
	return {
		id: `${source}__${target}`,
		source,
		target,
		red: {
			total: 1,
			errors: 0,
			errorRate: 0,
			rate: 1,
			p50: tgt?.red.p50 ?? 0,
			p95: tgt?.red.p95 ?? 0,
			p99: tgt?.red.p99 ?? 0
		}
	};
}

// ---------------------------------------------------------------------------
// combo 4 — step × window (aggregate logs across recent runs of a workflow)
// ---------------------------------------------------------------------------

async function buildStepGraphWindowed(
	workflow: ServiceGraphWorkflowContext,
	windowSeconds: number,
	logs: ServiceGraphStepLogRow[]
): Promise<{ nodes: ServiceGraphNode[]; edges: ServiceGraphEdge[] }> {
	const wfNodes = (workflow.nodes ?? []) as WorkflowNodeJson[];
	const wfEdges = (workflow.edges ?? []) as WorkflowEdgeJson[];

	const byNode = new Map<string, typeof logs>();
	for (const log of logs) {
		const list = byNode.get(log.nodeId) ?? [];
		list.push(log);
		byNode.set(log.nodeId, list);
	}

	const nodes: ServiceGraphNode[] = wfNodes.map((wn) => {
		const rows = byNode.get(wn.id) ?? [];
		const total = rows.length;
		const errors = rows.filter((r) => r.status === 'error').length;
		const durations = rows.map((r) => toNum(r.duration)).filter((d) => d > 0);
		const status: ServiceGraphNode['status'] = total === 0 ? 'idle' : errors > 0 ? 'error' : 'ok';
		return {
			id: wn.id,
			label: nodeLabel(wn),
			kind: 'step',
			status,
			red: {
				total,
				errors,
				errorRate: total > 0 ? errors / total : 0,
				rate: total / windowSeconds,
				...percentiles(durations)
			}
		};
	});
	const nodeIndex = new Map(nodes.map((n) => [n.id, n]));

	const edges: ServiceGraphEdge[] = [];
	for (const we of wfEdges) {
		if (!nodeIndex.has(we.source) || !nodeIndex.has(we.target) || we.source === we.target) continue;
		const src = nodeIndex.get(we.source)!;
		const tgt = nodeIndex.get(we.target)!;
		const total = Math.min(src.red.total, tgt.red.total);
		edges.push({
			id: `${we.source}__${we.target}`,
			source: we.source,
			target: we.target,
			red: {
				total,
				errors: src.red.errors,
				errorRate: src.red.errorRate,
				rate: total / windowSeconds,
				p50: tgt.red.p50,
				p95: tgt.red.p95,
				p99: tgt.red.p99
			}
		});
	}
	return { nodes, edges };
}

// ---------------------------------------------------------------------------
// insight enrichment (execution scope): tokens/cost, timing, retries, errors, critical path
// ---------------------------------------------------------------------------

const WORKFLOW_NODE_ATTR = 'workflow.node.id';
const WORKFLOW_ACTIVITY_ATTR = 'workflow.activity.correlation_id';
type StepLogRow = ServiceGraphStepLogRow;

/**
 * Map each spanId → the workflow node id of its nearest ancestor span that carries
 * `workflow.node.id`. Lets us attribute low-level LLM/error spans (which only have
 * http/gen_ai attrs) to the step that owns them.
 */
function buildSpanNodeMap(spans: ObservabilityTraceSpan[]): Map<string, string> {
	const byId = new Map(spans.map((s) => [s.spanId, s]));
	const memo = new Map<string, string | undefined>();
	const resolve = (spanId: string, seen: Set<string>): string | undefined => {
		if (memo.has(spanId)) return memo.get(spanId);
		const span = byId.get(spanId);
		if (!span || seen.has(spanId)) return undefined;
		seen.add(spanId);
		const own = span.attributes?.[WORKFLOW_NODE_ATTR];
		let nodeId = own != null && String(own) ? String(own) : undefined;
		if (!nodeId && span.parentSpanId) nodeId = resolve(span.parentSpanId, seen);
		memo.set(spanId, nodeId);
		return nodeId;
	};
	const out = new Map<string, string>();
	for (const s of spans) {
		const n = resolve(s.spanId, new Set());
		if (n) out.set(s.spanId, n);
	}
	return out;
}

interface InsightInput {
	mode: ServiceGraphMode;
	spans: ObservabilityTraceSpan[];
	llmSpans: GraphLlmSpan[];
	logs?: StepLogRow[];
	nodes: ServiceGraphNode[];
	edges: ServiceGraphEdge[];
}

/** Build per-node insight overlays (tokens/cost/timing/retries/errors) + critical path. Pure. */
function buildExecutionInsights(input: InsightInput): ServiceGraphInsights {
	const { mode, spans, llmSpans, logs, nodes, edges } = input;
	const nodeInsights: Record<string, NodeInsight> = {};
	const ensure = (id: string): NodeInsight => (nodeInsights[id] ??= {});
	const spanNode = mode === 'step' ? buildSpanNodeMap(spans) : null;
	const keyFor = (serviceName: string, spanId: string): string | undefined =>
		mode === 'service' ? collapseServiceName(serviceName) : spanNode?.get(spanId);

	// tokens + cost (LLM spans → service node or step node)
	for (const s of llmSpans) {
		const key = keyFor(s.serviceName, s.spanId);
		if (!key) continue;
		const ins = ensure(key);
		const t = (ins.tokens ??= {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheCreate: 0,
			total: 0
		});
		const inputTokens = s.promptTokens ?? 0;
		const outputTokens = s.completionTokens ?? 0;
		const cacheReadTokens = s.cacheReadInputTokens ?? 0;
		const cacheCreateTokens = s.cacheCreationInputTokens ?? 0;
		t.input += inputTokens;
		t.output += outputTokens;
		t.cacheRead += cacheReadTokens;
		t.cacheCreate += cacheCreateTokens;
		t.total += s.totalTokens ?? inputTokens + outputTokens;
		ins.costUsd =
			(ins.costUsd ?? 0) +
			costFor(s.modelName, {
				inputTokens,
				outputTokens,
				cacheReadTokens,
				cacheCreateTokens
			});
	}

	// timing breakdown + retries (step mode, from workflow_execution_logs)
	if (mode === 'step' && logs) {
		const byNode = new Map<string, StepLogRow[]>();
		for (const r of logs) {
			const list = byNode.get(r.nodeId) ?? [];
			list.push(r);
			byNode.set(r.nodeId, list);
		}
		for (const [nodeId, rows] of byNode) {
			const ins = ensure(nodeId);
			ins.retries = Math.max(0, rows.length - 1);
			const sum = (f: (r: StepLogRow) => number) => rows.reduce((acc, r) => acc + f(r), 0);
			ins.timing = {
				coldStartMs: sum((r) => r.coldStartMs ?? 0),
				routingMs: sum((r) => r.routingMs ?? 0),
				credentialFetchMs: sum((r) => r.credentialFetchMs ?? 0),
				executionMs: sum((r) => toNum(r.executionMs ?? r.duration)),
				wasColdStart: rows.some((r) => r.wasColdStart === true)
			};
		}
	}

	// error samples (cap 3 per node)
	for (const s of spans) {
		if (!isError(s)) continue;
		const key = keyFor(s.serviceName, s.spanId);
		if (!key) continue;
		const samples = (ensure(key).errorSamples ??= []);
		if (samples.length < 3) {
			samples.push({
				message: s.statusMessage || s.operationName || 'error',
				spanId: s.spanId,
				traceId: s.traceId
			});
		}
	}

	// workflow activity metadata (step mode): semantic activity ids plus Dapr
	// task ids observed on native durabletask spans for the selected node.
	if (mode === 'step' && spanNode) {
		for (const s of spans) {
			const key = spanNode.get(s.spanId);
			if (!key) continue;
			const attrs = s.attributes ?? {};
			const activity = (ensure(key).workflowActivity ??= {
				correlationIds: [],
				daprTaskIds: [],
				relatedSpanIds: [],
				servicesTouched: []
			});
			const correlationId = attrs[WORKFLOW_ACTIVITY_ATTR];
			if (correlationId != null) {
				const text = String(correlationId);
				if (text && !activity.correlationIds.includes(text)) activity.correlationIds.push(text);
			}
			const daprTaskId = attrs['durabletask.task.task_id'];
			if (daprTaskId != null) {
				const text = String(daprTaskId);
				if (text && !activity.daprTaskIds.includes(text)) activity.daprTaskIds.push(text);
			}
			if (!activity.relatedSpanIds.includes(s.spanId)) activity.relatedSpanIds.push(s.spanId);
			const service = collapseServiceName(s.serviceName);
			if (service && !activity.servicesTouched.includes(service))
				activity.servicesTouched.push(service);
		}
	}

	return {
		nodes: nodeInsights,
		edges: {},
		criticalPath: computeCriticalPath(nodes, edges)
	};
}

/**
 * Slowest end-to-end path through the graph. Node weight = self/own latency
 * (selfMs ?? p95); edge weight = edge p95. Memoized DFS with an on-stack guard so
 * retry-induced cycles (service mode) don't loop. Returns ordered node ids.
 */
export function computeCriticalPath(
	nodes: ServiceGraphNode[],
	edges: ServiceGraphEdge[]
): string[] {
	if (nodes.length === 0) return [];
	const nodeById = new Map(nodes.map((n) => [n.id, n]));
	const outgoing = new Map<string, ServiceGraphEdge[]>();
	const indeg = new Map<string, number>();
	for (const n of nodes) {
		outgoing.set(n.id, []);
		indeg.set(n.id, 0);
	}
	for (const e of edges) {
		if (!nodeById.has(e.source) || !nodeById.has(e.target) || e.source === e.target) continue;
		outgoing.get(e.source)!.push(e);
		indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
	}
	const nodeWeight = (id: string) => {
		const n = nodeById.get(id);
		return n ? (n.red.selfMs ?? n.red.p95 ?? 0) : 0;
	};
	const memo = new Map<string, { cost: number; path: string[] }>();
	const onStack = new Set<string>();
	const best = (id: string): { cost: number; path: string[] } => {
		const cached = memo.get(id);
		if (cached) return cached;
		if (onStack.has(id)) return { cost: 0, path: [] }; // break cycle
		onStack.add(id);
		let bestCost = 0;
		let bestPath: string[] = [];
		for (const e of outgoing.get(id) ?? []) {
			const child = best(e.target);
			const c = (e.red.p95 ?? 0) + child.cost;
			if (c > bestCost) {
				bestCost = c;
				bestPath = [e.target, ...child.path];
			}
		}
		onStack.delete(id);
		const result = { cost: nodeWeight(id) + bestCost, path: bestPath };
		memo.set(id, result);
		return result;
	};
	const entries = nodes
		.filter((n) => (indeg.get(n.id) ?? 0) === 0 || n.id === 'user')
		.map((n) => n.id);
	const starts = entries.length > 0 ? entries : nodes.map((n) => n.id);
	let top = { cost: -1, path: [] as string[] };
	let topStart = '';
	for (const s of starts) {
		const r = best(s);
		if (r.cost > top.cost) {
			top = r;
			topStart = s;
		}
	}
	return topStart ? [topStart, ...top.path] : [];
}

/** Best-effort insight computation (fetches LLM spans; falls back to critical path only). */
async function computeExecutionInsights(params: {
	mode: ServiceGraphMode;
	traceIds: string[];
	spans?: ObservabilityTraceSpan[];
	logs?: StepLogRow[];
	nodes: ServiceGraphNode[];
	edges: ServiceGraphEdge[];
	window?: TraceTimeWindow;
}): Promise<ServiceGraphInsights> {
	try {
		const spans =
			params.spans ??
			(params.traceIds.length
				? (await getMultiTraceSpanSummaries(params.traceIds, params.window)).spans
				: []);
		const llmSpans = params.traceIds.length
			? await getMultiTraceGraphLlmSpans(params.traceIds, params.window)
			: [];
		return buildExecutionInsights({
			mode: params.mode,
			spans,
			llmSpans,
			logs: params.logs,
			nodes: params.nodes,
			edges: params.edges
		});
	} catch {
		return {
			nodes: {},
			edges: {},
			criticalPath: computeCriticalPath(params.nodes, params.edges)
		};
	}
}

type DynamicScriptGraphTelemetry = {
	traceIds: string[];
	spans: ObservabilityTraceSpan[];
	llmSpans: GraphLlmSpan[];
	truncated: boolean;
	limit: number;
	degraded: boolean;
	warnings: string[];
};

function warnGraphEnrichmentFailure(
	executionId: string,
	source: 'trace discovery' | 'span timing' | 'LLM usage',
	reason: unknown
): void {
	console.warn(`[service-graph] Dynamic-script ${source} unavailable`, {
		executionId,
		message: reason instanceof Error ? reason.message : String(reason)
	});
}

async function loadDynamicScriptGraphTelemetry(
	execution: ExecutionRow
): Promise<DynamicScriptGraphTelemetry> {
	const warnings: string[] = [];
	let traceIds: string[];
	try {
		traceIds = await resolveExecutionTraceIds(execution);
	} catch (reason) {
		warnGraphEnrichmentFailure(execution.id, 'trace discovery', reason);
		return {
			traceIds: [],
			spans: [],
			llmSpans: [],
			truncated: false,
			limit: 0,
			degraded: true,
			warnings: ['Trace discovery unavailable; showing journal topology only']
		};
	}

	if (traceIds.length === 0) {
		return {
			traceIds,
			spans: [],
			llmSpans: [],
			truncated: false,
			limit: 0,
			degraded: true,
			warnings: ['No traces found; showing journal topology only']
		};
	}

	const window = {
		startedAt: execution.startedAt,
		completedAt: execution.completedAt
	};
	const [spanResult, llmResult] = await Promise.allSettled([
		getMultiTraceSpanSummaries(traceIds, window),
		getMultiTraceGraphLlmSpans(traceIds, window)
	]);

	let spans: ObservabilityTraceSpan[] = [];
	let truncated = false;
	let limit = 0;
	let degraded = false;
	if (spanResult.status === 'fulfilled') {
		spans = spanResult.value.spans;
		truncated = spanResult.value.truncated;
		limit = spanResult.value.limit;
		if (truncated) warnings.push(`Showing the first ${limit} span summaries`);
	} else {
		degraded = true;
		warnings.push('Span timing unavailable; showing journal topology without span metrics');
		warnGraphEnrichmentFailure(execution.id, 'span timing', spanResult.reason);
	}

	let llmSpans: GraphLlmSpan[] = [];
	if (llmResult.status === 'fulfilled') {
		llmSpans = llmResult.value;
	} else {
		degraded = true;
		warnings.push('LLM usage unavailable; token and cost metrics omitted');
		warnGraphEnrichmentFailure(execution.id, 'LLM usage', llmResult.reason);
	}

	return { traceIds, spans, llmSpans, truncated, limit, degraded, warnings };
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export interface BuildServiceGraphInput {
	query: ServiceGraphQuery;
	/** Pre-loaded + scope-validated by the API route (null when not found / N/A). */
	execution?: ExecutionRow | null;
	workflow?: ServiceGraphWorkflowContext | null;
	stepLogs?: ServiceGraphStepLogRow[];
	/** Dynamic-script executions: the call journal (steps ARE the calls). */
	scriptCalls?: ServiceGraphScriptCallRow[];
}

export async function buildServiceGraph(
	input: BuildServiceGraphInput
): Promise<ServiceGraphPayload> {
	const { query, execution, workflow } = input;
	const base = emptyServiceGraph(query);

	try {
		if (query.mode === 'service' && query.scope === 'execution') {
			if (!execution) return emptyServiceGraph(query, { warnings: ['Execution not found'] });
			const traceIds = await resolveExecutionTraceIds(execution);
			if (traceIds.length === 0) {
				return emptyServiceGraph(query, {
					warnings: ['No traces found for this execution']
				});
			}
			const spanBatch = await getMultiTraceSpanSummaries(traceIds, {
				startedAt: execution.startedAt,
				completedAt: execution.completedAt
			});
			const spans = spanBatch.spans;
			const { nodes, edges } = buildServiceGraphFromSpans(spans);
			const insights = await computeExecutionInsights({
				mode: 'service',
				traceIds,
				spans,
				nodes,
				edges,
				window: {
					startedAt: execution.startedAt,
					completedAt: execution.completedAt
				}
			});
			return {
				...base,
				nodes,
				edges,
				insights,
				meta: {
					spanCount: spans.length,
					traceCount: traceIds.length,
					truncated: spanBatch.truncated,
					warnings: spanBatch.truncated
						? [`Showing the first ${spanBatch.limit} span summaries`]
						: []
				}
			};
		}

		if (query.mode === 'service' && query.scope === 'window') {
			const { nodes, edges, truncated } = await buildServiceGraphWindowed(
				query.windowSeconds,
				query.workflowId
			);
			return {
				...base,
				nodes,
				edges,
				meta: {
					spanCount: edges.reduce((acc, e) => acc + e.red.total, 0),
					traceCount: 0,
					truncated,
					warnings: truncated ? [`Showing top ${EDGE_LIMIT} edges by volume`] : []
				}
			};
		}

		if (query.mode === 'step' && query.scope === 'execution') {
			if (!execution) return emptyServiceGraph(query, { warnings: ['Execution not found'] });
			// Dynamic-script runs have no SW step logs — their step graph IS the
			// call journal, enriched with per-session span timing + LLM usage.
			if (input.scriptCalls && input.scriptCalls.length > 0) {
				const telemetry = await loadDynamicScriptGraphTelemetry(execution);
				const { nodes, edges, insights } = buildStepGraphDynamicScript(
					input.scriptCalls,
					telemetry.spans,
					telemetry.llmSpans
				);
				return {
					...base,
					nodes,
					edges,
					insights,
					meta: {
						spanCount: telemetry.spans.length,
						traceCount: telemetry.traceIds.length,
						degraded: telemetry.degraded || undefined,
						truncated: telemetry.truncated,
						warnings: telemetry.warnings
					}
				};
			}
			if (!workflow) return emptyServiceGraph(query, { warnings: ['Workflow not found'] });
			const { nodes, edges, logs } = await buildStepGraphSingleExec(workflow, input.stepLogs ?? []);
			const traceIds = await resolveExecutionTraceIds(execution);
			const insights = await computeExecutionInsights({
				mode: 'step',
				traceIds,
				logs,
				nodes,
				edges,
				window: {
					startedAt: execution.startedAt,
					completedAt: execution.completedAt
				}
			});
			return {
				...base,
				nodes,
				edges,
				insights,
				meta: { spanCount: 0, traceCount: traceIds.length, warnings: [] }
			};
		}

		// step × window
		if (!workflow) {
			return emptyServiceGraph(query, {
				warnings: ['workflowId is required for step + window']
			});
		}
		const { nodes, edges } = await buildStepGraphWindowed(
			workflow,
			query.windowSeconds,
			input.stepLogs ?? []
		);
		return {
			...base,
			nodes,
			edges,
			meta: { spanCount: 0, traceCount: 0, warnings: [] }
		};
	} catch (err) {
		return emptyServiceGraph(query, {
			degraded: true,
			warnings: [`Failed to build graph: ${err instanceof Error ? err.message : String(err)}`]
		});
	}
}

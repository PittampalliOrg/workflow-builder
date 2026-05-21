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
 *   - StatusCode values are 'Unset' | 'Ok' | 'Error'. (The mapper in clickhouse.ts
 *     compares against 'STATUS_CODE_ERROR', which never matches — so we read the
 *     raw `statusCode` field here, not the derived `status`.)
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflowExecutionLogs, workflowExecutions, workflows } from '$lib/server/db/schema';
import type { ObservabilityTraceSpan } from '$lib/types/observability';
import {
	CLICKHOUSE_DB,
	escapeClickHouseString,
	extractExecutionTraceIds,
	findCorrelatedTraceIds,
	getMultiTraceSpans,
	queryClickHouse,
	sanitizeTraceIds
} from '$lib/server/otel/clickhouse';
import {
	emptyServiceGraph,
	type RedMetrics,
	type ServiceGraphEdge,
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

// ---------------------------------------------------------------------------
// small numeric helpers
// ---------------------------------------------------------------------------

function toNum(value: unknown): number {
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : 0;
}

/** Nearest-rank percentiles over an unsorted millisecond array. */
function percentiles(values: number[]): { p50: number; p95: number; p99: number } {
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
function collapseServiceName(name: string): string {
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
			n = { id, label, kind, total: 0, errors: 0, durations: [], selfDurations: [], status: 'idle' };
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

	finalize(perSecond: number | null): { nodes: ServiceGraphNode[]; edges: ServiceGraphEdge[] } {
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

type ExecutionRow = typeof workflowExecutions.$inferSelect;

/** Trace ids tagged with this execution id via the `workflow.execution.id` span attr. */
async function traceIdsByExecutionAttr(executionId: string): Promise<string[]> {
	const escaped = escapeClickHouseString(executionId.trim());
	if (!escaped) return [];
	const rows = await queryClickHouse(`
		SELECT DISTINCT TraceId FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE (mapContains(SpanAttributes, 'workflow.execution.id') AND SpanAttributes['workflow.execution.id'] = '${escaped}')
		   OR (mapContains(SpanAttributes, 'session.id') AND SpanAttributes['session.id'] = '${escaped}')
		ORDER BY TraceId`);
	return sanitizeTraceIds(rows.map((r) => String(r.TraceId ?? '')));
}

export async function resolveExecutionTraceIds(execution: ExecutionRow): Promise<string[]> {
	const ids = new Set<string>();
	if (execution.primaryTraceId) ids.add(execution.primaryTraceId.trim());
	for (const id of extractExecutionTraceIds(execution.output)) ids.add(id);
	for (const id of await traceIdsByExecutionAttr(execution.id)) ids.add(id);
	if (execution.workflowSessionId) {
		for (const id of await traceIdsByExecutionAttr(execution.workflowSessionId)) ids.add(id);
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
	return span.statusCode === ERROR_STATUS;
}

function virtualPeer(span: ObservabilityTraceSpan): { id: string; kind: ServiceGraphNodeKind; label: string } | null {
	const attrs = span.attributes ?? {};
	const dbSystem = attrs['db.system'] ?? attrs['db.namespace'];
	if (dbSystem) return { id: `db:${String(dbSystem)}`, kind: 'db', label: String(dbSystem) };
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
): Promise<{ nodes: ServiceGraphNode[]; edges: ServiceGraphEdge[]; truncated: boolean }> {
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

	// DB edges: client spans carrying db.system → virtual db node (uninstrumented).
	const dbRows = await queryClickHouse(`
		SELECT ServiceName source, SpanAttributes['db.system'] db, count() total,
			countIf(StatusCode='${ERROR_STATUS}') errors,
			quantile(0.5)(Duration/1000000) p50, quantile(0.95)(Duration/1000000) p95, quantile(0.99)(Duration/1000000) p99
		FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE Timestamp >= ${since} AND SpanKind IN ('Client','Producer')
			AND mapContains(SpanAttributes, 'db.system') AND SpanAttributes['db.system'] != '' ${wfFilter}
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
				red: { total: 0, errors: 0, errorRate: 0, rate: 0, p50: 0, p95: 0, p99: 0 }
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
	execution: ExecutionRow,
	workflow: typeof workflows.$inferSelect
): Promise<{ nodes: ServiceGraphNode[]; edges: ServiceGraphEdge[] }> {
	const wfNodes = (workflow.nodes ?? []) as WorkflowNodeJson[];
	const wfEdges = (workflow.edges ?? []) as WorkflowEdgeJson[];
	const logs = db
		? await db
				.select()
				.from(workflowExecutionLogs)
				.where(eq(workflowExecutionLogs.executionId, execution.id))
		: [];

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
		const status: ServiceGraphNode['status'] =
			total === 0 ? 'idle' : errors > 0 ? 'error' : 'ok';
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
	return { nodes, edges };
}

// ---------------------------------------------------------------------------
// combo 4 — step × window (aggregate logs across recent runs of a workflow)
// ---------------------------------------------------------------------------

async function buildStepGraphWindowed(
	workflow: typeof workflows.$inferSelect,
	windowSeconds: number
): Promise<{ nodes: ServiceGraphNode[]; edges: ServiceGraphEdge[] }> {
	const wfNodes = (workflow.nodes ?? []) as WorkflowNodeJson[];
	const wfEdges = (workflow.edges ?? []) as WorkflowEdgeJson[];
	const since = new Date(Date.now() - windowSeconds * 1000);

	// Recent execution ids for this workflow inside the window.
	const execRows = db
		? await db
				.select({ id: workflowExecutions.id })
				.from(workflowExecutions)
				.where(
					and(
						eq(workflowExecutions.workflowId, workflow.id),
						gte(workflowExecutions.startedAt, since)
					)
				)
				.orderBy(desc(workflowExecutions.startedAt))
				.limit(2000)
		: [];
	const execIds = execRows.map((r) => r.id);

	const logs =
		db && execIds.length > 0
			? await db
					.select()
					.from(workflowExecutionLogs)
					.where(inArray(workflowExecutionLogs.executionId, execIds))
			: [];

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
		const status: ServiceGraphNode['status'] =
			total === 0 ? 'idle' : errors > 0 ? 'error' : 'ok';
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
// dispatcher
// ---------------------------------------------------------------------------

export interface BuildServiceGraphInput {
	query: ServiceGraphQuery;
	/** Pre-loaded + scope-validated by the API route (null when not found / N/A). */
	execution?: ExecutionRow | null;
	workflow?: (typeof workflows.$inferSelect) | null;
}

export async function buildServiceGraph(input: BuildServiceGraphInput): Promise<ServiceGraphPayload> {
	const { query, execution, workflow } = input;
	const base = emptyServiceGraph(query);

	try {
		if (query.mode === 'service' && query.scope === 'execution') {
			if (!execution) return emptyServiceGraph(query, { warnings: ['Execution not found'] });
			const traceIds = await resolveExecutionTraceIds(execution);
			if (traceIds.length === 0) {
				return emptyServiceGraph(query, { warnings: ['No traces found for this execution'] });
			}
			const spans = await getMultiTraceSpans(traceIds);
			const { nodes, edges } = buildServiceGraphFromSpans(spans);
			return {
				...base,
				nodes,
				edges,
				meta: { spanCount: spans.length, traceCount: traceIds.length, warnings: [] }
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
			if (!workflow) return emptyServiceGraph(query, { warnings: ['Workflow not found'] });
			const { nodes, edges } = await buildStepGraphSingleExec(execution, workflow);
			return { ...base, nodes, edges, meta: { spanCount: 0, traceCount: 0, warnings: [] } };
		}

		// step × window
		if (!workflow) {
			return emptyServiceGraph(query, { warnings: ['workflowId is required for step + window'] });
		}
		const { nodes, edges } = await buildStepGraphWindowed(workflow, query.windowSeconds);
		return { ...base, nodes, edges, meta: { spanCount: 0, traceCount: 0, warnings: [] } };
	} catch (err) {
		return emptyServiceGraph(query, {
			degraded: true,
			warnings: [`Failed to build graph: ${err instanceof Error ? err.message : String(err)}`]
		});
	}
}

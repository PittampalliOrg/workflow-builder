/**
 * Deterministic run digest — the "what happened" summary computed with ZERO
 * LLM calls, from data the platform already has: the script-call journal,
 * the run's connected trace spans, and the curated LLM spans.
 *
 * Powers the digest card + issues rail on the run's Graph view, and the
 * `trace_get_digest` MCP tool the trace-analyst chat uses as its ground truth.
 */
import type { ObservabilityTraceSpan } from '$lib/types/observability';
import type { GraphLlmSpan } from '$lib/server/otel/clickhouse';
import {
	buildStepGraphDynamicScript,
	type ServiceGraphScriptCallRow
} from '$lib/server/otel/service-graph';
import { costFor } from '$lib/server/pricing/model-pricing';
import type {
	RunDigest,
	RunDigestPhase,
	RunIssue
} from '$lib/types/run-digest';

export type { RunDigest, RunDigestPhase, RunIssue } from '$lib/types/run-digest';

export type BuildRunDigestInput = {
	execution: {
		id: string;
		status: string;
		startedAt: Date | string | null;
		completedAt: Date | string | null;
		output?: unknown;
		budgetTotal?: number | null;
	};
	calls: ServiceGraphScriptCallRow[];
	spans: ObservabilityTraceSpan[];
	llmSpans: GraphLlmSpan[];
};

const MAX_SPAN_ISSUES = 5;
const MAX_CHAIN = 12;

function toIso(value: Date | string | null | undefined): string | null {
	if (!value) return null;
	if (value instanceof Date) return value.toISOString();
	return value;
}

function isErrorSpan(s: ObservabilityTraceSpan): boolean {
	return (
		(s.status === 'error' || s.statusCode === 'Error') &&
		!isExpectedKubernetesNotFound(s)
	);
}

function attributeString(
	attributes: Record<string, unknown> | undefined,
	...keys: string[]
): string | null {
	for (const key of keys) {
		const value = attributes?.[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
		if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	}
	return null;
}

function httpPath(attributes: Record<string, unknown> | undefined): string | null {
	const value = attributeString(attributes, 'url.path', 'http.target', 'url.full', 'http.url');
	if (!value) return null;
	try {
		return new URL(value, 'http://kubernetes.invalid').pathname;
	} catch {
		return value.split('?', 1)[0] || null;
	}
}

/** Exclude only Kubernetes 404s whose client adapter explicitly treats absence as success. */
function isExpectedKubernetesNotFound(span: ObservabilityTraceSpan): boolean {
	const attributes = span.attributes;
	if (
		attributeString(attributes, 'http.response.status_code', 'http.status_code') !== '404'
	) {
		return false;
	}

	const method = attributeString(attributes, 'http.request.method', 'http.method')?.toUpperCase();
	const path = httpPath(attributes);
	if (!method || !path) return false;

	const sandboxResource =
		/^\/apis\/extensions\.agents\.x-k8s\.io\/v1alpha1\/namespaces\/[^/]+\/(sandboxwarmpools|sandboxtemplates)\/[^/]+\/?$/.exec(
			path
		)?.[1] ?? null;
	if (method === 'GET') return sandboxResource === 'sandboxwarmpools';
	if (method !== 'DELETE') return false;
	if (sandboxResource) return true;

	return /^\/api\/v1\/namespaces\/[^/]+\/services\/agent-runtime-[^/]+-mcp\/?$/.test(path);
}

/** Walk ParentSpanId ancestry from a failing span up to its root. */
function failureChain(
	span: ObservabilityTraceSpan,
	spans: ObservabilityTraceSpan[]
): { name: string; service: string; spanId: string }[] {
	const byId = new Map(spans.map((s) => [s.spanId, s]));
	const chain: { name: string; service: string; spanId: string }[] = [];
	let cursor: ObservabilityTraceSpan | undefined = span;
	const seen = new Set<string>();
	while (cursor && chain.length < MAX_CHAIN && !seen.has(cursor.spanId)) {
		seen.add(cursor.spanId);
		chain.push({
			name: cursor.operationName,
			service: cursor.serviceName,
			spanId: cursor.spanId
		});
		cursor = cursor.parentSpanId ? byId.get(cursor.parentSpanId) : undefined;
	}
	return chain.reverse(); // root → leaf reads as the causal path
}

export function buildRunDigest(input: BuildRunDigestInput): RunDigest {
	const { execution, calls, spans, llmSpans } = input;

	// Reuse the step-graph builder: per-call durations from spans (by the
	// deterministic child session.id) + the critical path.
	const graph = buildStepGraphDynamicScript(calls, spans, llmSpans);
	const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

	// ── totals ──────────────────────────────────────────────────────────────
	let tokensIn = 0;
	let tokensOut = 0;
	let cacheRead = 0;
	let cacheCreation = 0;
	let costUsd = 0;
	for (const s of llmSpans) {
		const i = s.promptTokens ?? 0;
		const o = s.completionTokens ?? 0;
		const cr = s.cacheReadInputTokens ?? 0;
		const cc = s.cacheCreationInputTokens ?? 0;
		tokensIn += i;
		tokensOut += o;
		cacheRead += cr;
		cacheCreation += cc;
		costUsd += costFor(s.modelName, {
			inputTokens: i,
			outputTokens: o,
			cacheReadTokens: cr,
			cacheCreateTokens: cc
		});
	}
	const sessions = new Set(calls.map((c) => c.sessionId).filter(Boolean)).size;

	// ── phases (journal order) ──────────────────────────────────────────────
	const phaseOrder: string[] = [];
	const phaseAgg = new Map<string, RunDigestPhase>();
	for (const call of [...calls].sort((a, b) => a.seq - b.seq)) {
		const title = call.phase ?? '(no phase)';
		if (!phaseAgg.has(title)) {
			phaseOrder.push(title);
			phaseAgg.set(title, {
				title,
				calls: 0,
				done: 0,
				errors: 0,
				running: 0,
				durationMs: 0,
				tokens: 0,
				costUsd: 0
			});
		}
		const agg = phaseAgg.get(title)!;
		agg.calls += 1;
		if (call.status === 'done') agg.done += 1;
		if (call.status === 'error') agg.errors += 1;
		if (call.status === 'running') agg.running += 1;
		const node = nodeById.get(call.callId);
		// Phase duration = max per-call duration (calls in a phase run in parallel).
		agg.durationMs = Math.max(agg.durationMs, node?.red.selfMs ?? 0);
		const ins = graph.insights.nodes[call.callId];
		agg.tokens += ins?.tokens?.total ?? 0;
		agg.costUsd += ins?.costUsd ?? 0;
	}

	// ── critical path ───────────────────────────────────────────────────────
	const pathIds = graph.insights.criticalPath ?? [];
	const startedAt = toIso(execution.startedAt);
	const completedAt = toIso(execution.completedAt);
	const wallClockMs =
		startedAt && completedAt ? Date.parse(completedAt) - Date.parse(startedAt) : null;
	let criticalPath: RunDigest['criticalPath'] = null;
	if (pathIds.length > 0) {
		const durationMs = pathIds.reduce(
			(acc, id) => acc + (nodeById.get(id)?.red.selfMs ?? 0),
			0
		);
		criticalPath = {
			ids: pathIds,
			labels: pathIds.map((id) => nodeById.get(id)?.label ?? id),
			durationMs,
			pctOfWallClock:
				wallClockMs && wallClockMs > 0
					? Math.min(100, Math.round((durationMs / wallClockMs) * 100))
					: null
		};
	}

	// ── issues ──────────────────────────────────────────────────────────────
	const issues: RunIssue[] = [];
	const runOutput = execution.output as { error?: unknown } | null | undefined;
	if (execution.status === 'error') {
		issues.push({
			kind: 'run_error',
			label: 'Run failed',
			detail:
				typeof runOutput?.error === 'string'
					? runOutput.error
					: runOutput?.error != null
						? JSON.stringify(runOutput.error).slice(0, 300)
						: null,
			callId: null,
			spanId: null,
			traceId: null
		});
	}
	const callLabel = (c: ServiceGraphScriptCallRow) =>
		c.label || `${c.kind} #${c.seq + 1}`;
	for (const call of calls) {
		if (call.status === 'error') {
			issues.push({
				kind: 'call_error',
				label: `${callLabel(call)} failed`,
				detail: call.errorCode,
				callId: call.callId,
				spanId: null,
				traceId: null
			});
		} else if (call.retries > 0) {
			issues.push({
				kind: 'call_retries',
				label: `${callLabel(call)} retried ×${call.retries}`,
				detail: call.errorCode,
				callId: call.callId,
				spanId: null,
				traceId: null
			});
		}
	}
	const sessionToCall = new Map(
		calls.filter((c) => c.sessionId).map((c) => [c.sessionId as string, c])
	);
	let chainAttached = false;
	let spanIssues = 0;
	for (const s of spans) {
		if (!isErrorSpan(s)) continue;
		if (spanIssues >= MAX_SPAN_ISSUES) break;
		spanIssues += 1;
		const owner = s.attributes?.['session.id']
			? sessionToCall.get(String(s.attributes['session.id']))
			: undefined;
		issues.push({
			kind: 'span_error',
			label: `${s.serviceName}: ${s.operationName}`,
			detail: s.statusMessage || null,
			callId: owner?.callId ?? null,
			spanId: s.spanId,
			traceId: s.traceId,
			...(chainAttached ? {} : { chain: failureChain(s, spans) })
		});
		chainAttached = true;
	}

	return {
		executionId: execution.id,
		status: execution.status,
		startedAt,
		completedAt,
		wallClockMs,
		totals: {
			calls: calls.length,
			sessions,
			llmCalls: llmSpans.length,
			tokensIn,
			tokensOut,
			cacheRead,
			cacheCreation,
			tokens: tokensIn + tokensOut + cacheRead + cacheCreation,
			costUsd,
			cacheHitRate:
				cacheRead + tokensIn > 0 ? cacheRead / (cacheRead + tokensIn) : null
		},
		phases: phaseOrder.map((t) => phaseAgg.get(t)!),
		criticalPath,
		budget:
			execution.budgetTotal != null
				? {
						total: execution.budgetTotal,
						spentTokens: tokensIn + tokensOut + cacheCreation
					}
				: null,
		issues
	};
}

/**
 * Load + assemble the RunDigest for an execution the caller has already
 * scope-validated. Shared by the public digest route (user auth) and the
 * internal observability routes (internal token + session-project match)
 * behind the trace-analyst MCP tools.
 */
import { getApplicationAdapters } from '$lib/server/application';
import {
	getMultiTraceLlmSpans,
	getMultiTraceSpans,
	isClickHouseConfigured
} from '$lib/server/otel/clickhouse';
import { resolveExecutionTraceIds } from '$lib/server/otel/service-graph';
import { buildRunDigest, type RunDigest } from './run-digest';

export type DigestExecutionRow = {
	id: string;
	status: string;
	startedAt: Date | string | null;
	completedAt: Date | string | null;
	output: unknown;
	executionIr?: unknown;
	primaryTraceId: string | null;
	workflowSessionId?: string | null;
};

type TraceBundle = {
	calls: {
		callId: string;
		seq: number;
		kind: string;
		label: string | null;
		phase: string | null;
		status: string;
		sessionId: string | null;
		retries: number;
		errorCode: string | null;
	}[];
	traceIds: string[];
	spans: Awaited<ReturnType<typeof getMultiTraceSpans>>;
	llmSpans: Awaited<ReturnType<typeof getMultiTraceLlmSpans>>;
};

// Short-TTL bundle cache: the run page polls the digest (6s) + graph (5s)
// while trace tools fire in bursts — each used to re-fetch the FULL span
// bundle from ClickHouse (~1MB over the dev→hub egress), and the resulting
// concurrent streams are exactly what stalled a reviewer's tool call. One
// fetch per execution per TTL window is plenty for eventually-consistent
// telemetry.
const BUNDLE_TTL_MS = Number(process.env.TRACE_BUNDLE_CACHE_TTL_MS) || 15_000;
const BUNDLE_CACHE_MAX = 24;
const bundleCache = new Map<string, { at: number; bundle: Promise<TraceBundle> }>();

export async function loadExecutionTraceBundle(
	execution: DigestExecutionRow
): Promise<TraceBundle> {
	const cached = bundleCache.get(execution.id);
	if (cached && Date.now() - cached.at < BUNDLE_TTL_MS) return cached.bundle;
	const bundle = loadExecutionTraceBundleUncached(execution).catch((err) => {
		bundleCache.delete(execution.id);
		throw err;
	});
	bundleCache.set(execution.id, { at: Date.now(), bundle });
	if (bundleCache.size > BUNDLE_CACHE_MAX) {
		const oldest = [...bundleCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
		if (oldest) bundleCache.delete(oldest[0]);
	}
	return bundle;
}

async function loadExecutionTraceBundleUncached(
	execution: DigestExecutionRow
): Promise<TraceBundle> {
	const app = getApplicationAdapters();
	const calls = await app.scriptCalls
		.listInternal(execution.id)
		.then((rows) =>
			rows.map((r) => ({
				callId: r.callId,
				seq: r.seq,
				kind: r.kind,
				label: r.label,
				phase: r.phase,
				status: r.status ?? 'null',
				sessionId: r.sessionId,
				retries: r.retries ?? 0,
				errorCode: r.errorCode
			}))
		)
		.catch(() => []);

	let traceIds: string[] = [];
	let spans: Awaited<ReturnType<typeof getMultiTraceSpans>> = [];
	let llmSpans: Awaited<ReturnType<typeof getMultiTraceLlmSpans>> = [];
	if (isClickHouseConfigured()) {
		// Degrade, never throw: a slow/terminated ClickHouse egress must yield a
		// journal-only digest (matching the traces-route 503-degradation
		// convention), not a 500 on the run page's digest poll.
		try {
			traceIds = await resolveExecutionTraceIds({
				id: execution.id,
				output: execution.output,
				primaryTraceId: execution.primaryTraceId,
				workflowSessionId: execution.workflowSessionId ?? null,
				startedAt: execution.startedAt ? new Date(execution.startedAt) : new Date(0),
				completedAt: execution.completedAt ? new Date(execution.completedAt) : null
			});
			if (traceIds.length > 0) {
				[spans, llmSpans] = await Promise.all([
					getMultiTraceSpans(traceIds),
					getMultiTraceLlmSpans(traceIds)
				]);
			}
		} catch (err) {
			console.warn(
				`[trace-bundle] ClickHouse load degraded for ${execution.id}:`,
				err instanceof Error ? err.message : err
			);
			spans = [];
			llmSpans = [];
		}
	}
	return { calls, traceIds, spans, llmSpans };
}

/** Trace ids only — for SQL-side span search (no bundle fetch). */
export async function resolveTraceIdsForExecution(
	execution: DigestExecutionRow
): Promise<string[]> {
	if (!isClickHouseConfigured()) return [];
	try {
		return await resolveExecutionTraceIds({
			id: execution.id,
			output: execution.output,
			primaryTraceId: execution.primaryTraceId,
			workflowSessionId: execution.workflowSessionId ?? null,
			startedAt: execution.startedAt ? new Date(execution.startedAt) : new Date(0),
			completedAt: execution.completedAt ? new Date(execution.completedAt) : null
		});
	} catch {
		return [];
	}
}

export async function buildRunDigestForExecution(
	execution: DigestExecutionRow
): Promise<RunDigest> {
	const { calls, spans, llmSpans } = await loadExecutionTraceBundle(execution);
	const ir = execution.executionIr as { budgetTotal?: unknown } | null | undefined;
	return buildRunDigest({
		execution: {
			id: execution.id,
			status: execution.status,
			startedAt: execution.startedAt,
			completedAt: execution.completedAt,
			output: execution.output,
			budgetTotal: typeof ir?.budgetTotal === 'number' ? ir.budgetTotal : null
		},
		calls,
		spans,
		llmSpans
	});
}

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

export async function loadExecutionTraceBundle(execution: DigestExecutionRow) {
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
	}
	return { calls, traceIds, spans, llmSpans };
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

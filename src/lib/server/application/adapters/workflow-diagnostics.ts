import type {
	WorkflowDiagnosticsDigestRead,
	WorkflowDiagnosticsExecution,
	WorkflowDiagnosticsReadPort,
	WorkflowDiagnosticsTraceResolution
} from '$lib/server/application/ports/workflow-diagnostics';
import {
	getMultiTraceDigestLlmSpans,
	getMultiTraceSpanSummaries,
	getTraceSpanDetailForTraces,
	isClickHouseConfigured,
	searchTraceLlmSpans,
	searchTraceLogs,
	searchTraceSpanSummaries,
	searchTraceToolSpans
} from '$lib/server/otel/clickhouse';
import { resolveExecutionTraceIds } from '$lib/server/otel/service-graph';
import { buildRunDigest } from '$lib/server/observability/run-digest';
import { collectWorkflowDiagnosticsEvidence } from './workflow-diagnostics-evidence';

type WorkflowDiagnosticsAdapterDependencies = {
	listScriptCalls(executionId: string): Promise<WorkflowDiagnosticsDigestRead['calls']>;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** ClickHouse/run-digest adapter for the workflow diagnostics read boundary. */
export class ClickHouseWorkflowDiagnosticsReadAdapter implements WorkflowDiagnosticsReadPort {
	constructor(private readonly deps: WorkflowDiagnosticsAdapterDependencies) {}

	isConfigured(): boolean {
		return isClickHouseConfigured();
	}

	async loadDigest(
		execution: WorkflowDiagnosticsExecution
	): Promise<WorkflowDiagnosticsDigestRead> {
		const warnings: string[] = [];
		const degradedSources: WorkflowDiagnosticsDigestRead['degradedSources'] = [];
		const calls = await this.deps.listScriptCalls(execution.id).catch((error) => {
			degradedSources.push('journal');
			warnings.push(`Script-call journal unavailable: ${errorMessage(error)}`);
			return [];
		});
		let traceIds: string[] = [];
		let spans: WorkflowDiagnosticsDigestRead['spans'] = [];
		let llmSpans: Awaited<ReturnType<typeof getMultiTraceDigestLlmSpans>>['spans'] = [];
		let llmSpansTruncated = false;
		let llmSpanLimit = 0;
		if (this.isConfigured()) {
			try {
				const resolution = await this.resolveTraceIds(execution);
				traceIds = resolution.traceIds;
				if (resolution.warnings.length > 0) {
					degradedSources.push('correlation');
					warnings.push(...resolution.warnings);
				}
			} catch (error) {
				degradedSources.push('correlation');
				warnings.push(`Trace correlation unavailable: ${errorMessage(error)}`);
			}
			if (traceIds.length > 0) {
				const window = {
					startedAt: execution.startedAt,
					completedAt: execution.completedAt
				};
				const [spanResult, llmResult] = await Promise.allSettled([
					getMultiTraceSpanSummaries(traceIds, window),
					getMultiTraceDigestLlmSpans(traceIds, window)
				]);
				if (spanResult.status === 'fulfilled') {
					spans = spanResult.value.spans;
					if (spanResult.value.truncated) {
						degradedSources.push('spans');
						warnings.push(`Span summaries were limited to ${spanResult.value.limit} rows`);
					}
				} else {
					degradedSources.push('spans');
					warnings.push(`Span summaries unavailable: ${errorMessage(spanResult.reason)}`);
				}
				if (llmResult.status === 'fulfilled') {
					llmSpans = llmResult.value.spans;
					llmSpansTruncated = llmResult.value.truncated;
					llmSpanLimit = llmResult.value.limit;
				} else {
					degradedSources.push('llm');
					warnings.push(`LLM metadata unavailable: ${errorMessage(llmResult.reason)}`);
				}
			}
		}
		const ir = execution.executionIr as { budgetTotal?: unknown } | null | undefined;
		const digest = buildRunDigest({
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
		return {
			digest,
			traceIds,
			spans,
			llmTurnCount: llmSpans.length,
			llmSpansTruncated,
			llmSpanLimit,
			calls,
			degradedSources,
			warnings
		};
	}

	async resolveTraceIds(
		execution: WorkflowDiagnosticsExecution
	): Promise<WorkflowDiagnosticsTraceResolution> {
		const warnings: string[] = [];
		const traceIds = await resolveExecutionTraceIds(
			{
				id: execution.id,
				output: null,
				primaryTraceId: execution.primaryTraceId,
				workflowSessionId: execution.workflowSessionId ?? null,
				startedAt: execution.startedAt ? new Date(execution.startedAt) : new Date(0),
				completedAt: execution.completedAt ? new Date(execution.completedAt) : null
			},
			{
				includeTimeWindowFallback: false,
				onWarning: (warning) => warnings.push(warning)
			}
		);
		return { traceIds, warnings };
	}

	loadInvestigationEvidence(
		execution: WorkflowDiagnosticsExecution,
		request: Parameters<WorkflowDiagnosticsReadPort['loadInvestigationEvidence']>[1]
	) {
		const serviceNames = request.serviceNames.length > 0 ? request.serviceNames : undefined;
		const window = {
			startedAt: execution.startedAt,
			completedAt: execution.completedAt
		};
		return collectWorkflowDiagnosticsEvidence({
			execution,
			request,
			resolveTraceIds: () => this.resolveTraceIds(execution),
			queries: {
				spans: async (traceIds, limit) =>
					(
						await getMultiTraceSpanSummaries(traceIds, {
							serviceNames,
							limit,
							...window
						})
					).spans,
				logs: (traceIds, limit) =>
					searchTraceLogs(traceIds, { serviceNames, limit, offset: 0, ...window }),
				llmSpans: (traceIds, limit) =>
					searchTraceLlmSpans(traceIds, {
						workflowExecutionId: execution.id,
						serviceNames,
						limit,
						offset: 0,
						...window
					}),
				toolSpans: (traceIds, limit) =>
					searchTraceToolSpans(traceIds, {
						workflowExecutionId: execution.id,
						serviceNames,
						limit,
						offset: 0,
						...window
					})
			}
		});
	}

	searchSpans(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		query: Parameters<WorkflowDiagnosticsReadPort['searchSpans']>[2]
	) {
		return searchTraceSpanSummaries(traceIds, {
			...query,
			startedAt: execution.startedAt,
			completedAt: execution.completedAt
		}).then((batch) => batch.spans);
	}

	getSpan(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		spanId: string
	) {
		return getTraceSpanDetailForTraces(traceIds, spanId, {
			startedAt: execution.startedAt,
			completedAt: execution.completedAt
		});
	}

	searchLlmSpans(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		query: Parameters<WorkflowDiagnosticsReadPort['searchLlmSpans']>[2]
	) {
		return searchTraceLlmSpans(traceIds, {
			...query,
			startedAt: execution.startedAt,
			completedAt: execution.completedAt
		});
	}

	searchLogs(
		execution: WorkflowDiagnosticsExecution,
		traceIds: string[],
		query: Parameters<WorkflowDiagnosticsReadPort['searchLogs']>[2]
	) {
		return searchTraceLogs(traceIds, {
			...query,
			startedAt: execution.startedAt,
			completedAt: execution.completedAt
		});
	}
}

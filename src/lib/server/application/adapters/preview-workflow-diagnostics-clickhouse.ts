import type {
	PreviewControlIdentity,
	PreviewWorkflowDiagnosticsQueryPort,
	WorkflowDiagnosticsExecution
} from '$lib/server/application/ports';
import { validatePreviewControlIdentity } from '$lib/server/application/preview-control-identity';
import {
	CLICKHOUSE_DB,
	escapeClickHouseString,
	getMultiTraceDigestLlmSpans,
	getMultiTraceSpanSummaries,
	getTraceSpanDetailForTraces,
	isClickHouseConfigured,
	queryClickHouse,
	sanitizeTraceIds,
	searchTraceLlmSpans,
	searchTraceLogs,
	searchTraceSpanSummaries,
	searchTraceToolSpans,
	type TraceResourceScope
} from '$lib/server/otel/clickhouse';
import { collectWorkflowDiagnosticsEvidence } from './workflow-diagnostics-evidence';

const MAX_TRACE_IDS = 200;
const DIGEST_SPAN_LIMIT = Math.min(
	5_000,
	Math.max(100, Number(process.env.PREVIEW_DIAGNOSTICS_DIGEST_SPAN_LIMIT) || 2_000)
);
const DIGEST_LLM_LIMIT = Math.min(
	5_000,
	Math.max(100, Number(process.env.PREVIEW_DIAGNOSTICS_DIGEST_LLM_LIMIT) || 2_000)
);

type ClickHouseQuery = (sql: string) => Promise<Record<string, unknown>[]>;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function exactTupleScope(identity: PreviewControlIdentity): TraceResourceScope {
	const value = validatePreviewControlIdentity(identity);
	return Object.freeze({
		'deployment.environment': 'dev-preview',
		'preview.name': value.previewName,
		'preview.request_id': value.environmentRequestId,
		'preview.platform_revision': value.environmentPlatformRevision,
		'preview.source_revision': value.environmentSourceRevision,
		'preview.catalog_digest': value.catalogDigest
	});
}

function tupleClauses(scope: TraceResourceScope): string[] {
	return Object.entries(scope).map(
		([key, value]) =>
			`ResourceAttributes['${escapeClickHouseString(key)}'] = '${escapeClickHouseString(value)}'`
	);
}

function timestamp(value: Date | string | null | undefined): string | null {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.getTime())) return null;
	return date.toISOString().replace('T', ' ').replace('Z', '');
}

function executionWindow(execution: WorkflowDiagnosticsExecution): string[] {
	const startedAt = timestamp(new Date(new Date(execution.startedAt).getTime() - 5_000));
	const completedAt = timestamp(
		new Date((execution.completedAt?.getTime() ?? Date.now()) + 10_000)
	);
	return [
		...(startedAt ? [`Timestamp >= '${startedAt}'`] : []),
		...(completedAt ? [`Timestamp <= '${completedAt}'`] : [])
	];
}

function executionCorrelationClause(value: string): string {
	const escaped = escapeClickHouseString(value);
	return `(
		(SpanAttributes['workflow.execution.id'] = '${escaped}') OR
		(SpanAttributes['workflow_execution_id'] = '${escaped}') OR
		(ResourceAttributes['workflow.execution.id'] = '${escaped}') OR
		(ResourceAttributes['workflow_execution_id'] = '${escaped}')
	)`;
}

function sessionCorrelationClause(value: string): string {
	const escaped = escapeClickHouseString(value);
	return `(
		(SpanAttributes['session.id'] = '${escaped}') OR
		(ResourceAttributes['session.id'] = '${escaped}')
	)`;
}

/** Physical ClickHouse adapter. Every returned row is fenced to one immutable preview tuple. */
export class ClickHousePreviewWorkflowDiagnosticsQueryAdapter
	implements PreviewWorkflowDiagnosticsQueryPort
{
	constructor(private readonly queryImpl: ClickHouseQuery = queryClickHouse) {}

	isConfigured(): boolean {
		return isClickHouseConfigured();
	}

	async resolveTraceIds(input: {
		identity: PreviewControlIdentity;
		execution: WorkflowDiagnosticsExecution;
	}) {
		const scope = exactTupleScope(input.identity);
		const correlations = [executionCorrelationClause(input.execution.id.trim())];
		if (input.execution.workflowSessionId?.trim()) {
			correlations.push(sessionCorrelationClause(input.execution.workflowSessionId.trim()));
		}
		const primary = sanitizeTraceIds([input.execution.primaryTraceId ?? '']);
		const candidates = [
			...correlations,
			...(primary.length > 0
				? [`TraceId IN (${primary.map((id) => `'${escapeClickHouseString(id)}'`).join(', ')})`]
				: [])
		];
		if (candidates.length === 0) return { traceIds: [], warnings: [] };
		const rows = await this.queryImpl(`
			SELECT DISTINCT TraceId
			FROM ${CLICKHOUSE_DB}.otel_traces
			WHERE ${tupleClauses(scope).join(' AND ')}
			  AND ${executionWindow(input.execution).join(' AND ')}
			  AND (${candidates.join(' OR ')})
			ORDER BY TraceId
			LIMIT ${MAX_TRACE_IDS}
		`);
		return {
			traceIds: sanitizeTraceIds(rows.map((row) => String(row.TraceId ?? ''))).slice(
				0,
				MAX_TRACE_IDS
			),
			warnings: []
		};
	}

	private async allowedTraceIds(input: {
		identity: PreviewControlIdentity;
		execution: WorkflowDiagnosticsExecution;
		traceIds: string[];
	}): Promise<string[]> {
		const resolution = await this.resolveTraceIds(input);
		const allowed = new Set(resolution.traceIds);
		return [...new Set(sanitizeTraceIds(input.traceIds))].filter((id) => allowed.has(id));
	}

	async loadDigestTelemetry(input: {
		identity: PreviewControlIdentity;
		execution: WorkflowDiagnosticsExecution;
	}) {
		const degradedSources: Array<'correlation' | 'spans' | 'llm'> = [];
		const warnings: string[] = [];
		let traceIds: string[] = [];
		try {
			const resolution = await this.resolveTraceIds(input);
			traceIds = resolution.traceIds;
			warnings.push(...resolution.warnings);
		} catch (error) {
			degradedSources.push('correlation');
			warnings.push(`Trace correlation unavailable: ${errorMessage(error)}`);
		}
		let spans: Awaited<ReturnType<typeof getMultiTraceSpanSummaries>>['spans'] = [];
		let llmSpans: Awaited<ReturnType<typeof getMultiTraceDigestLlmSpans>>['spans'] = [];
		let llmSpansTruncated = false;
		let llmSpanLimit = DIGEST_LLM_LIMIT;
		if (traceIds.length > 0) {
			const scope = exactTupleScope(input.identity);
			const window = {
				startedAt: input.execution.startedAt,
				completedAt: input.execution.completedAt
			};
			const [spanResult, llmResult] = await Promise.allSettled([
				getMultiTraceSpanSummaries(traceIds, {
					...window,
					limit: DIGEST_SPAN_LIMIT,
					resourceScope: scope
				}),
				getMultiTraceDigestLlmSpans(traceIds, window, DIGEST_LLM_LIMIT, scope)
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
		return {
			traceIds,
			spans,
			llmSpans,
			llmSpansTruncated,
			llmSpanLimit,
			degradedSources,
			warnings
		};
	}

	loadInvestigationEvidence(
		input: Parameters<PreviewWorkflowDiagnosticsQueryPort['loadInvestigationEvidence']>[0]
	) {
		const scope = exactTupleScope(input.identity);
		const window = {
			startedAt: input.execution.startedAt,
			completedAt: input.execution.completedAt
		};
		const serviceNames =
			input.request.serviceNames.length > 0 ? input.request.serviceNames : undefined;
		return collectWorkflowDiagnosticsEvidence({
			execution: input.execution,
			request: input.request,
			resolveTraceIds: () => this.resolveTraceIds(input),
			queries: {
				spans: async (traceIds, limit) =>
					(
						await getMultiTraceSpanSummaries(traceIds, {
							serviceNames,
							limit,
							resourceScope: scope,
							...window
						})
					).spans,
				logs: (traceIds, limit) =>
					searchTraceLogs(traceIds, {
						serviceNames,
						limit,
						offset: 0,
						resourceScope: scope,
						...window
					}),
				llmSpans: (traceIds, limit) =>
					searchTraceLlmSpans(traceIds, {
						workflowExecutionId: input.execution.id,
						serviceNames,
						limit,
						offset: 0,
						traceResourceScope: scope,
						...window
					}),
				toolSpans: (traceIds, limit) =>
					searchTraceToolSpans(traceIds, {
						workflowExecutionId: input.execution.id,
						serviceNames,
						limit,
						offset: 0,
						traceResourceScope: scope,
						...window
					})
			}
		});
	}

	async searchSpans(input: Parameters<PreviewWorkflowDiagnosticsQueryPort['searchSpans']>[0]) {
		const traceIds = await this.allowedTraceIds(input);
		return searchTraceSpanSummaries(traceIds, {
			...input.query,
			resourceScope: exactTupleScope(input.identity),
			startedAt: input.execution.startedAt,
			completedAt: input.execution.completedAt
		}).then((batch) => batch.spans);
	}

	async getSpan(input: Parameters<PreviewWorkflowDiagnosticsQueryPort['getSpan']>[0]) {
		const traceIds = await this.allowedTraceIds(input);
		return getTraceSpanDetailForTraces(traceIds, input.spanId, {
			resourceScope: exactTupleScope(input.identity),
			startedAt: input.execution.startedAt,
			completedAt: input.execution.completedAt
		});
	}

	async searchLlmSpans(
		input: Parameters<PreviewWorkflowDiagnosticsQueryPort['searchLlmSpans']>[0]
	) {
		const traceIds = await this.allowedTraceIds(input);
		return searchTraceLlmSpans(traceIds, {
			...input.query,
			traceResourceScope: exactTupleScope(input.identity),
			startedAt: input.execution.startedAt,
			completedAt: input.execution.completedAt
		});
	}

	async searchLogs(input: Parameters<PreviewWorkflowDiagnosticsQueryPort['searchLogs']>[0]) {
		const traceIds = await this.allowedTraceIds(input);
		return searchTraceLogs(traceIds, {
			...input.query,
			resourceScope: exactTupleScope(input.identity),
			startedAt: input.execution.startedAt,
			completedAt: input.execution.completedAt
		});
	}
}

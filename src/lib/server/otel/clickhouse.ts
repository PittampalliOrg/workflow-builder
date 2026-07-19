import { env } from '$env/dynamic/private';
import type {
	ObservabilityLlmSpan,
	ObservabilityLogEntry,
	ObservabilityToolSpan,
	ObservabilityTraceSpan
} from '$lib/types/observability';

export const CLICKHOUSE_URL =
	env.CLICKHOUSE_URL ?? 'http://otel-clickhouse.observability.svc.cluster.local:8123';
export const CLICKHOUSE_USER = env.CLICKHOUSE_USER ?? 'default';
export const CLICKHOUSE_PASSWORD = env.CLICKHOUSE_PASSWORD ?? 'otel_dev_password';
export const CLICKHOUSE_DB = env.CLICKHOUSE_DB ?? 'otel';
export const CLICKHOUSE_OBS_DB = env.CLICKHOUSE_OBS_DB ?? 'obs';

function safeJsonParse<T>(value: unknown, fallback: T): T {
	if (typeof value !== 'string' || !value.trim()) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function toNullableNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
			? Number(value)
			: null;
}

function toBoolean(value: unknown): boolean {
	return value === true || value === 1 || value === '1';
}

export type TraceTimeWindow = {
	startedAt?: string | Date | null;
	completedAt?: string | Date | null;
};

export type TraceSpanSummaryOptions = TraceTimeWindow & {
	serviceNames?: string[];
	limit?: number;
};

export type TraceSpanSummaryBatch = {
	spans: ObservabilityTraceSpan[];
	truncated: boolean;
	limit: number;
};

export type GraphLlmSpan = Pick<
	ObservabilityLlmSpan,
	| 'traceId'
	| 'spanId'
	| 'serviceName'
	| 'sessionId'
	| 'modelName'
	| 'promptTokens'
	| 'completionTokens'
	| 'totalTokens'
	| 'cacheReadInputTokens'
	| 'cacheCreationInputTokens'
>;

/**
 * Cheap "is ClickHouse wired up" check. The connection constants above always
 * carry an in-cluster default, so on an environment WITHOUT ClickHouse (e.g. a
 * vcluster preview) the `CLICKHOUSE_URL` env var is simply unset — treat that as
 * not-configured so trace routes can degrade to 503 instead of throwing 500 when
 * the fetch to a non-existent host fails.
 */
export function isClickHouseConfigured(): boolean {
	return Boolean(env.CLICKHOUSE_URL && env.CLICKHOUSE_URL.trim());
}

/** Hard ceiling on any single ClickHouse round-trip. A stalled connection
 * through the dev→hub egress must FAIL (callers degrade) rather than hang the
 * request chain — a hung trace-tool fetch stalls an agent activity forever. */
const CLICKHOUSE_TIMEOUT_MS = Number(process.env.CLICKHOUSE_TIMEOUT_MS) || 30_000;
const TRACE_SPAN_SUMMARY_TIMEOUT_MS = Number(process.env.TRACE_SPAN_SUMMARY_TIMEOUT_MS) || 20_000;
const TRACE_SPAN_SUMMARY_LIMIT = Number(process.env.TRACE_SPAN_SUMMARY_LIMIT) || 20_000;

export async function queryClickHouse(
	sql: string,
	options: { timeoutMs?: number } = {}
): Promise<Record<string, unknown>[]> {
	const res = await fetch(CLICKHOUSE_URL, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${Buffer.from(`${CLICKHOUSE_USER}:${CLICKHOUSE_PASSWORD}`).toString('base64')}`
		},
		body: `${sql} FORMAT JSONEachRow`,
		signal: AbortSignal.timeout(options.timeoutMs ?? CLICKHOUSE_TIMEOUT_MS)
	});
	if (!res.ok) throw new Error(`ClickHouse error: ${res.status}`);
	const text = await res.text();
	if (!text.trim()) return [];
	return text
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
}

export function escapeClickHouseString(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

export function sanitizeTraceIds(traceIds: string[]): string[] {
	return traceIds
		.filter((id) => typeof id === 'string' && /^[a-f0-9]+$/i.test(id.trim()))
		.map((id) => id.trim());
}

/**
 * Build an `AND (ServiceName ...)` clause for the service-graph drill-down so we
 * fetch only the selected service(s)' rows. Expands the collapsed `agent-session`
 * topology node back to the per-session `agent-session-<hex>` service names.
 */
export function serviceNameClause(serviceNames?: string[]): string {
	if (!serviceNames || serviceNames.length === 0) return '';
	const exact = serviceNames
		.filter((n) => n && n !== 'agent-session')
		.map((n) => `'${escapeClickHouseString(n)}'`);
	const parts: string[] = [];
	if (exact.length) parts.push(`ServiceName IN (${exact.join(', ')})`);
	if (serviceNames.includes('agent-session')) {
		parts.push(`(ServiceName = 'agent-session' OR ServiceName LIKE 'agent-session-%')`);
	}
	return parts.length ? `AND (${parts.join(' OR ')})` : '';
}

export function mapObservabilityLog(row: Record<string, unknown>): ObservabilityLogEntry {
	return {
		timestamp: row.Timestamp as string,
		traceId: (row.TraceId as string) ?? '',
		spanId: (row.SpanId as string) ?? '',
		serviceName: (row.ServiceName as string) ?? 'unknown',
		severityText: (row.SeverityText as string) ?? 'info',
		body: (row.Body as string) ?? '',
		resourceAttributes: (row.ResourceAttributes as Record<string, unknown>) ?? {},
		logAttributes: (row.LogAttributes as Record<string, unknown>) ?? {}
	};
}

function mapObservabilityLlmSpan(row: Record<string, unknown>): ObservabilityLlmSpan {
	return {
		timestamp: String(row.Timestamp ?? ''),
		traceId: String(row.TraceId ?? ''),
		spanId: String(row.SpanId ?? ''),
		parentSpanId: row.ParentSpanId ? String(row.ParentSpanId) : null,
		serviceName: String(row.ServiceName ?? 'unknown'),
		sessionId: String(row.SessionId ?? ''),
		workflowExecutionId: String(row.WorkflowExecutionId ?? ''),
		agentRunId: row.AgentRunId ? String(row.AgentRunId) : null,
		statusCode: String(row.StatusCode ?? ''),
		modelName: row.ModelName ? String(row.ModelName) : null,
		provider: row.Provider ? String(row.Provider) : null,
		inputMessages: safeJsonParse(row.InputMessages, []),
		outputMessages: safeJsonParse(row.OutputMessages, []),
		invocationParameters: safeJsonParse<Record<string, unknown> | null>(
			row.InvocationParameters,
			null
		),
		finishReason: row.FinishReason ? String(row.FinishReason) : null,
		promptTokens: toNullableNumber(row.PromptTokens),
		completionTokens: toNullableNumber(row.CompletionTokens),
		totalTokens: toNullableNumber(row.TotalTokens),
		cacheReadInputTokens: toNullableNumber(row.CacheReadInputTokens),
		cacheCreationInputTokens: toNullableNumber(row.CacheCreationInputTokens),
		reasoningTokens: toNullableNumber(row.ReasoningTokens),
		inputMessagesTruncated: Boolean(row.InputMessagesTruncated),
		outputMessagesTruncated: Boolean(row.OutputMessagesTruncated),
		invocationParametersTruncated: Boolean(row.InvocationParametersTruncated)
	};
}

function mapGraphLlmSpan(row: Record<string, unknown>): GraphLlmSpan {
	return {
		traceId: String(row.TraceId ?? ''),
		spanId: String(row.SpanId ?? ''),
		serviceName: String(row.ServiceName ?? 'unknown'),
		sessionId: String(row.SessionId ?? ''),
		modelName: row.ModelName ? String(row.ModelName) : null,
		promptTokens: toNullableNumber(row.PromptTokens),
		completionTokens: toNullableNumber(row.CompletionTokens),
		totalTokens: toNullableNumber(row.TotalTokens),
		cacheReadInputTokens: toNullableNumber(row.CacheReadInputTokens),
		cacheCreationInputTokens: toNullableNumber(row.CacheCreationInputTokens)
	};
}

function mapObservabilityToolSpan(row: Record<string, unknown>): ObservabilityToolSpan {
	return {
		timestamp: String(row.Timestamp ?? ''),
		traceId: String(row.TraceId ?? ''),
		spanId: String(row.SpanId ?? ''),
		parentSpanId: row.ParentSpanId ? String(row.ParentSpanId) : null,
		serviceName: String(row.ServiceName ?? 'unknown'),
		sessionId: String(row.SessionId ?? ''),
		workflowExecutionId: String(row.WorkflowExecutionId ?? ''),
		agentRunId: row.AgentRunId ? String(row.AgentRunId) : null,
		statusCode: String(row.StatusCode ?? ''),
		toolName: String(row.ToolName ?? ''),
		toolArguments: safeJsonParse(row.ToolArguments, row.ToolArguments ?? null),
		toolResult: safeJsonParse(row.ToolResult, row.ToolResult ?? null),
		toolArgumentsTruncated: Boolean(row.ToolArgumentsTruncated),
		toolResultTruncated: Boolean(row.ToolResultTruncated)
	};
}

function mapObservabilityTraceSpan(
	row: Record<string, unknown>
): Omit<ObservabilityTraceSpan, 'depth'> {
	const statusCode = row.StatusCode ? String(row.StatusCode) : undefined;
	return {
		traceId: String(row.TraceId ?? ''),
		spanId: String(row.SpanId ?? ''),
		parentSpanId: row.ParentSpanId ? String(row.ParentSpanId) : null,
		operationName: String(row.SpanName ?? ''),
		serviceName: String(row.ServiceName ?? 'unknown'),
		startTime: String(row.Timestamp ?? ''),
		duration: Math.round(Number(row.DurationMs ?? 0)),
		statusCode,
		statusMessage: row.StatusMessage ? String(row.StatusMessage) : undefined,
		spanKind: row.SpanKind ? String(row.SpanKind) : undefined,
		attributes: (row.SpanAttributes as Record<string, unknown>) ?? {},
		resourceAttributes: (row.ResourceAttributes as Record<string, unknown>) ?? {},
		status: statusCode === 'Error' || statusCode === 'STATUS_CODE_ERROR' ? 'error' : 'ok'
	};
}

const COMPACT_SPAN_ATTRIBUTE_KEYS = [
	'session.id',
	'workflow.execution.id',
	'workflow_execution_id',
	'agent.run.id',
	'agent_run_id',
	'workflow.node.id',
	'workflow.node.name',
	'workflow.node.action_type',
	'workflow.node.sequence',
	'node.id',
	'node.name',
	'node.action_type',
	'action.type',
	'workflow.activity.correlation_id',
	'durabletask.task.task_id',
	'durabletask.task.name',
	'workflow.id',
	'workflow.name',
	'db.system.name',
	'db.system',
	'db.namespace',
	'db.collection.name',
	'db.operation.name',
	'peer.service',
	'server.address',
	'net.peer.name',
	'http.method',
	'http.request.method',
	'http.route',
	'http.target',
	'http.url',
	'http.status_code',
	'http.response.status_code',
	'url.full',
	'url.path',
	'rpc.system',
	'rpc.service',
	'rpc.method',
	'messaging.system',
	'messaging.operation',
	'gen_ai.operation.name',
	'gen_ai.request.model',
	'gen_ai.response.model',
	'llm.model_name',
	'model',
	'model_name',
	'openinference.span.kind',
	'mlflow.spanType',
	'span.type',
	'durabletask.type',
	'tool.name',
	'tool_name',
	'mcp.tool.name',
	'function.name',
	'gen_ai.tool.name',
	'error',
	'error.type',
	'exception.type',
	'exception.message'
] as const;

const COMPACT_RESOURCE_ATTRIBUTE_KEYS = [
	'session.id',
	'workflow.execution.id',
	'workflow_execution_id',
	'agent.run.id',
	'agent_run_id'
] as const;

function compactAttributeSelect(
	column: 'SpanAttributes' | 'ResourceAttributes',
	prefix: string,
	keys: readonly string[]
): string {
	return keys.map((key, index) => `${column}['${key}'] AS ${prefix}${index}`).join(',\n\t\t\t');
}

function mapCompactAttributes(
	row: Record<string, unknown>,
	prefix: string,
	keys: readonly string[]
): Record<string, unknown> {
	const attributes: Record<string, unknown> = {};
	for (const [index, key] of keys.entries()) {
		const value = row[`${prefix}${index}`];
		if (value !== undefined && value !== null && value !== '') attributes[key] = value;
	}
	return attributes;
}

function mapObservabilityTraceSpanSummary(
	row: Record<string, unknown>
): Omit<ObservabilityTraceSpan, 'depth'> {
	return {
		...mapObservabilityTraceSpan({
			...row,
			SpanAttributes: mapCompactAttributes(row, 'SpanAttr', COMPACT_SPAN_ATTRIBUTE_KEYS),
			ResourceAttributes: mapCompactAttributes(row, 'ResourceAttr', COMPACT_RESOURCE_ATTRIBUTE_KEYS)
		}),
		attributesTruncated: true,
		hasInput: toBoolean(row.HasInput),
		hasOutput: toBoolean(row.HasOutput),
		inputSize: Math.max(0, Number(row.InputSize ?? 0)),
		outputSize: Math.max(0, Number(row.OutputSize ?? 0))
	};
}

async function queryObservabilityLogs(whereClause: string): Promise<ObservabilityLogEntry[]> {
	const rows = await queryClickHouse(`
		SELECT
			Timestamp,
			TraceId,
			SpanId,
			ServiceName,
			SeverityText,
			Body,
			ResourceAttributes,
			LogAttributes
		FROM ${CLICKHOUSE_DB}.otel_logs
		${whereClause}
		ORDER BY Timestamp ASC
	`);
	return rows.map(mapObservabilityLog);
}

async function queryObservabilityLlmSpans(whereClause: string): Promise<ObservabilityLlmSpan[]> {
	const rows = await queryClickHouse(`
		SELECT
			Timestamp,
			TraceId,
			SpanId,
			ParentSpanId,
			ServiceName,
			SessionId,
			WorkflowExecutionId,
			AgentRunId,
			ModelName,
			Provider,
			InputMessages,
			OutputMessages,
			InvocationParameters,
			FinishReason,
			PromptTokens,
			CompletionTokens,
			TotalTokens,
			CacheReadInputTokens,
			CacheCreationInputTokens,
			ReasoningTokens,
			StatusCode,
			InputMessagesTruncated,
			OutputMessagesTruncated,
			InvocationParametersTruncated
		FROM ${CLICKHOUSE_OBS_DB}.llm_spans
		${whereClause}
		ORDER BY Timestamp ASC
	`);
	return rows.map(mapObservabilityLlmSpan);
}

async function queryGraphLlmSpans(
	whereClause: string,
	options: { limit?: number } = {}
): Promise<GraphLlmSpan[]> {
	const limitClause = options.limit ? `LIMIT ${Math.max(1, Math.floor(options.limit))}` : '';
	const rows = await queryClickHouse(`
		SELECT
			TraceId,
			SpanId,
			ServiceName,
			SessionId,
			ModelName,
			PromptTokens,
			CompletionTokens,
			TotalTokens,
			CacheReadInputTokens,
			CacheCreationInputTokens
		FROM ${CLICKHOUSE_OBS_DB}.llm_spans
		${whereClause}
		ORDER BY Timestamp ASC
		${limitClause}
	`);
	return rows.map(mapGraphLlmSpan);
}

async function queryObservabilityToolSpans(whereClause: string): Promise<ObservabilityToolSpan[]> {
	const rows = await queryClickHouse(`
		SELECT
			Timestamp,
			TraceId,
			SpanId,
			ParentSpanId,
			ServiceName,
			SessionId,
			WorkflowExecutionId,
			AgentRunId,
			ToolName,
			ToolArguments,
			ToolResult,
			StatusCode,
			ToolArgumentsTruncated,
			ToolResultTruncated
		FROM ${CLICKHOUSE_OBS_DB}.tool_spans
		${whereClause}
		-- Dedupe: the OpenInference instrumentor tags several spans per tool call
		-- (the canonical run_tool span with name+args+result, PLUS a content-less
		-- execute_tool<X> span and load_tools/save_tool_results bookkeeping spans
		-- with no tool.name). Keep only spans that carry an actual tool name AND
		-- real argument or result content.
		AND ToolName != ''
		AND (ToolArguments != '{}' OR ToolResult != '{}')
		ORDER BY Timestamp ASC
	`);
	return rows.map(mapObservabilityToolSpan);
}

async function getSessionTraceIds(sessionId: string): Promise<string[]> {
	const escaped = escapeClickHouseString(sessionId.trim());
	if (!escaped) return [];
	const rows = await queryClickHouse(`
		SELECT DISTINCT TraceId
		FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE
			(mapContains(SpanAttributes, 'session.id') AND SpanAttributes['session.id'] = '${escaped}')
			OR (mapContains(ResourceAttributes, 'session.id') AND ResourceAttributes['session.id'] = '${escaped}')
			OR (mapContains(SpanAttributes, 'workflow.execution.id') AND SpanAttributes['workflow.execution.id'] = '${escaped}')
			OR (mapContains(ResourceAttributes, 'workflow.execution.id') AND ResourceAttributes['workflow.execution.id'] = '${escaped}')
		ORDER BY TraceId
	`);
	return sanitizeTraceIds(rows.map((row) => String(row.TraceId ?? '')));
}

function enrichTraceDepths(
	spans: Omit<ObservabilityTraceSpan, 'depth'>[]
): ObservabilityTraceSpan[] {
	const byTrace = new Map<string, Omit<ObservabilityTraceSpan, 'depth'>[]>();
	for (const span of spans) {
		const group = byTrace.get(span.traceId) ?? [];
		group.push(span);
		byTrace.set(span.traceId, group);
	}

	const enriched: ObservabilityTraceSpan[] = [];
	for (const traceSpans of byTrace.values()) {
		const spanMap = new Map(traceSpans.map((span) => [span.spanId, span]));
		const depthMap = new Map<string, number>();
		const getDepth = (spanId: string): number => {
			const cached = depthMap.get(spanId);
			if (cached != null) return cached;
			const span = spanMap.get(spanId);
			if (!span?.parentSpanId || !spanMap.has(span.parentSpanId)) {
				depthMap.set(spanId, 0);
				return 0;
			}
			const depth = getDepth(span.parentSpanId) + 1;
			depthMap.set(spanId, depth);
			return depth;
		};

		for (const span of traceSpans) {
			enriched.push({
				...span,
				depth: getDepth(span.spanId)
			});
		}
	}

	return enriched.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

async function queryTraceSpans(whereClause: string): Promise<ObservabilityTraceSpan[]> {
	const rows = await queryClickHouse(`
		SELECT
			TraceId,
			SpanId,
			ParentSpanId,
			SpanName,
			SpanKind,
			ServiceName,
			Duration/1000000 AS DurationMs,
			StatusCode,
			StatusMessage,
			Timestamp,
			SpanAttributes,
			ResourceAttributes
		FROM ${CLICKHOUSE_DB}.otel_traces
		${whereClause}
		ORDER BY Timestamp ASC
	`);
	return enrichTraceDepths(rows.map(mapObservabilityTraceSpan));
}

function clickHouseTimestamp(value: string | Date | null | undefined): string | null {
	if (value == null) return null;
	const date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.getTime())) return null;
	return date.toISOString().replace('T', ' ').replace('Z', '');
}

function traceTimeWindowClause(window: TraceTimeWindow = {}): string {
	const startValue = window.startedAt == null ? null : new Date(window.startedAt);
	const start =
		startValue && Number.isFinite(startValue.getTime())
			? clickHouseTimestamp(new Date(startValue.getTime() - 5_000))
			: null;
	const completedValue = window.completedAt == null ? null : new Date(window.completedAt);
	const end =
		completedValue && Number.isFinite(completedValue.getTime())
			? clickHouseTimestamp(new Date(completedValue.getTime() + 10_000))
			: start
				? clickHouseTimestamp(new Date(Date.now() + 10_000))
				: null;
	return [start ? `AND Timestamp >= '${start}'` : '', end ? `AND Timestamp <= '${end}'` : '']
		.filter(Boolean)
		.join(' ');
}

async function queryTraceSpanSummaries(
	whereClause: string,
	options: TraceSpanSummaryOptions = {}
): Promise<TraceSpanSummaryBatch> {
	const configuredLimit = Number.isFinite(options.limit)
		? Number(options.limit)
		: TRACE_SPAN_SUMMARY_LIMIT;
	const limit = Math.min(50_000, Math.max(1, Math.floor(configuredLimit)));
	const rows = await queryClickHouse(
		`
		SELECT
			TraceId,
			SpanId,
			ParentSpanId,
			SpanName,
			SpanKind,
			ServiceName,
			Duration/1000000 AS DurationMs,
			StatusCode,
			StatusMessage,
			Timestamp,
			${compactAttributeSelect('SpanAttributes', 'SpanAttr', COMPACT_SPAN_ATTRIBUTE_KEYS)},
			${compactAttributeSelect('ResourceAttributes', 'ResourceAttr', COMPACT_RESOURCE_ATTRIBUTE_KEYS)},
			mapContains(SpanAttributes, 'input.value') AS HasInput,
			mapContains(SpanAttributes, 'output.value') AS HasOutput,
			length(SpanAttributes['input.value']) AS InputSize,
			length(SpanAttributes['output.value']) AS OutputSize
		FROM ${CLICKHOUSE_DB}.otel_traces
		${whereClause}
		${traceTimeWindowClause(options)}
		${serviceNameClause(options.serviceNames)}
		ORDER BY Timestamp ASC, TraceId ASC, SpanId ASC
		LIMIT ${limit + 1}
	`,
		{ timeoutMs: TRACE_SPAN_SUMMARY_TIMEOUT_MS }
	);
	const truncated = rows.length > limit;
	return {
		spans: enrichTraceDepths(rows.slice(0, limit).map(mapObservabilityTraceSpanSummary)),
		truncated,
		limit
	};
}

export async function getTraceSpanSummaries(
	traceId: string,
	options: TraceSpanSummaryOptions = {}
): Promise<TraceSpanSummaryBatch> {
	return queryTraceSpanSummaries(`WHERE TraceId = '${escapeClickHouseString(traceId)}'`, options);
}

export async function getMultiTraceSpanSummaries(
	traceIds: string[],
	options: TraceSpanSummaryOptions = {}
): Promise<TraceSpanSummaryBatch> {
	const sanitized = sanitizeTraceIds(traceIds);
	const limit = Math.min(
		50_000,
		Math.max(1, Math.floor(options.limit ?? TRACE_SPAN_SUMMARY_LIMIT))
	);
	if (sanitized.length === 0) return { spans: [], truncated: false, limit };
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	return queryTraceSpanSummaries(`WHERE TraceId IN (${inClause})`, options);
}

export async function getSessionTraceSpanSummaries(
	sessionId: string,
	options: TraceSpanSummaryOptions = {}
): Promise<TraceSpanSummaryBatch> {
	const traceIds = await getSessionTraceIds(sessionId);
	return getMultiTraceSpanSummaries(traceIds, options);
}

export async function getTraceSpanDetail(
	traceId: string,
	spanId: string
): Promise<ObservabilityTraceSpan | null> {
	const sanitizedTraceIds = sanitizeTraceIds([traceId]);
	const normalizedSpanId = spanId.trim();
	if (sanitizedTraceIds.length === 0 || !/^[a-f0-9]+$/i.test(normalizedSpanId)) return null;
	const rows = await queryClickHouse(`
		SELECT
			TraceId,
			SpanId,
			ParentSpanId,
			SpanName,
			SpanKind,
			ServiceName,
			Duration/1000000 AS DurationMs,
			StatusCode,
			StatusMessage,
			Timestamp,
			SpanAttributes,
			ResourceAttributes
		FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE TraceId = '${escapeClickHouseString(sanitizedTraceIds[0])}'
		  AND SpanId = '${escapeClickHouseString(normalizedSpanId)}'
		ORDER BY Timestamp ASC
		LIMIT 1
	`);
	if (rows.length === 0) return null;
	return enrichTraceDepths(rows.map(mapObservabilityTraceSpan))[0] ?? null;
}

export async function getTraceSpanDetailForTraces(
	traceIds: string[],
	spanId: string
): Promise<ObservabilityTraceSpan | null> {
	const sanitizedTraceIds = sanitizeTraceIds(traceIds);
	const normalizedSpanId = spanId.trim();
	if (sanitizedTraceIds.length === 0 || !/^[a-f0-9]+$/i.test(normalizedSpanId)) return null;
	const inClause = sanitizedTraceIds
		.map((id) => `'${escapeClickHouseString(id)}'`)
		.join(', ');
	const rows = await queryClickHouse(`
		SELECT
			TraceId,
			SpanId,
			ParentSpanId,
			SpanName,
			SpanKind,
			ServiceName,
			Duration/1000000 AS DurationMs,
			StatusCode,
			StatusMessage,
			Timestamp,
			SpanAttributes,
			ResourceAttributes
		FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE TraceId IN (${inClause})
		  AND SpanId = '${escapeClickHouseString(normalizedSpanId)}'
		ORDER BY Timestamp ASC, TraceId ASC
		LIMIT 1
	`);
	return rows.length > 0 ? (enrichTraceDepths(rows.map(mapObservabilityTraceSpan))[0] ?? null) : null;
}

export async function getTraceLogs(traceId: string): Promise<ObservabilityLogEntry[]> {
	return queryObservabilityLogs(`WHERE TraceId = '${escapeClickHouseString(traceId)}'`);
}

export async function getMultiTraceLogs(
	traceIds: string[],
	serviceNames?: string[],
	window: TraceTimeWindow = {}
): Promise<ObservabilityLogEntry[]> {
	const sanitized = sanitizeTraceIds(traceIds);
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	return queryObservabilityLogs(
		`WHERE TraceId IN (${inClause}) ${serviceNameClause(serviceNames)} ${traceTimeWindowClause(window)}`
	);
}

/**
 * SQL-side log search for the trace-analyst `/logs` route: pushes the SpanId /
 * errorsOnly filters AND the row LIMIT into ClickHouse so a huge trace never
 * ships all its log rows across the dev->hub egress (the un-bounded
 * `getMultiTraceLogs` fetch-all-then-slice is a latency hazard on 16k-row
 * traces). Mirrors `searchTraceSpans`; own query because `queryObservabilityLogs`
 * appends `ORDER BY` after the caller's where-clause (can't inject LIMIT there).
 */
export async function searchTraceLogs(
	traceIds: string[],
	opts: {
		spanId?: string;
		query?: string;
		errorsOnly?: boolean;
		limit?: number;
		offset?: number;
	} = {}
): Promise<ObservabilityLogEntry[]> {
	const sanitized = sanitizeTraceIds(traceIds);
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	const clauses = [`TraceId IN (${inClause})`];
	if (opts.spanId?.trim()) {
		clauses.push(`SpanId = '${escapeClickHouseString(opts.spanId.trim())}'`);
	}
	if (opts.errorsOnly) {
		clauses.push(
			`(positionCaseInsensitive(SeverityText, 'error') > 0` +
				` OR positionCaseInsensitive(SeverityText, 'fatal') > 0)`
		);
	}
	if (opts.query?.trim()) {
		const query = escapeClickHouseString(opts.query.trim());
		clauses.push(
			`(positionCaseInsensitive(Body, '${query}') > 0` +
				` OR positionCaseInsensitive(ServiceName, '${query}') > 0` +
				` OR positionCaseInsensitive(SeverityText, '${query}') > 0)`
		);
	}
	const limit = Math.min(201, Math.max(1, opts.limit ?? 50));
	const offset = Math.max(0, opts.offset ?? 0);
	const rows = await queryClickHouse(`
		SELECT
			Timestamp,
			TraceId,
			SpanId,
			ServiceName,
			SeverityText,
			Body,
			ResourceAttributes,
			LogAttributes
		FROM ${CLICKHOUSE_DB}.otel_logs
		WHERE ${clauses.join(' AND ')}
		ORDER BY Timestamp ASC, TraceId ASC, SpanId ASC
		LIMIT ${limit}
		OFFSET ${offset}
	`);
	return rows.map(mapObservabilityLog);
}

export async function getSessionLogs(sessionId: string): Promise<ObservabilityLogEntry[]> {
	const escaped = escapeClickHouseString(sessionId.trim());
	if (!escaped) return [];
	const traceIds = await getSessionTraceIds(sessionId);
	const traceClause =
		traceIds.length > 0
			? ` OR TraceId IN (${traceIds.map((id) => `'${escapeClickHouseString(id)}'`).join(', ')})`
			: '';
	return queryObservabilityLogs(`
		WHERE
			(
				(mapContains(LogAttributes, 'session.id') AND LogAttributes['session.id'] = '${escaped}')
				OR (mapContains(ResourceAttributes, 'session.id') AND ResourceAttributes['session.id'] = '${escaped}')
				OR (mapContains(LogAttributes, 'workflow.execution.id') AND LogAttributes['workflow.execution.id'] = '${escaped}')
				OR (mapContains(ResourceAttributes, 'workflow.execution.id') AND ResourceAttributes['workflow.execution.id'] = '${escaped}')
				${traceClause}
			)
	`);
}

export async function getTraceSpans(traceId: string): Promise<ObservabilityTraceSpan[]> {
	return queryTraceSpans(`WHERE TraceId = '${escapeClickHouseString(traceId)}'`);
}

export async function getMultiTraceSpans(
	traceIds: string[],
	serviceNames?: string[]
): Promise<ObservabilityTraceSpan[]> {
	const sanitized = sanitizeTraceIds(traceIds);
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	return queryTraceSpans(`WHERE TraceId IN (${inClause}) ${serviceNameClause(serviceNames)}`);
}

/**
 * SQL-side span search for the trace-analyst tools: substring match over
 * operation/service/status-message/session-id with LIMIT pushed into
 * ClickHouse — a search must never require shipping the full trace bundle.
 */
export async function searchTraceSpans(
	traceIds: string[],
	opts: { query?: string; errorsOnly?: boolean; limit?: number; offset?: number } = {}
): Promise<ObservabilityTraceSpan[]> {
	const sanitized = sanitizeTraceIds(traceIds);
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	const clauses = [`TraceId IN (${inClause})`];
	if (opts.errorsOnly) clauses.push(`StatusCode = 'Error'`);
	if (opts.query?.trim()) {
		const q = escapeClickHouseString(opts.query.trim());
		clauses.push(
			`(positionCaseInsensitive(SpanName, '${q}') > 0` +
				` OR positionCaseInsensitive(ServiceName, '${q}') > 0` +
				` OR positionCaseInsensitive(StatusMessage, '${q}') > 0` +
				` OR positionCaseInsensitive(SpanAttributes['session.id'], '${q}') > 0)`
		);
	}
	const limit = Math.min(201, Math.max(1, opts.limit ?? 40));
	const offset = Math.max(0, opts.offset ?? 0);
	const rows = await queryClickHouse(`
		SELECT
			TraceId,
			SpanId,
			ParentSpanId,
			SpanName,
			SpanKind,
			ServiceName,
			Duration/1000000 AS DurationMs,
			StatusCode,
			StatusMessage,
			Timestamp,
			SpanAttributes,
			ResourceAttributes
		FROM ${CLICKHOUSE_DB}.otel_traces
		WHERE ${clauses.join(' AND ')}
		ORDER BY Timestamp ASC, TraceId ASC, SpanId ASC
		LIMIT ${limit}
		OFFSET ${offset}
	`);
	return enrichTraceDepths(rows.map(mapObservabilityTraceSpan));
}

/** SQL-bounded LLM evidence lookup for one span or one child session. */
export async function searchTraceLlmSpans(
	traceIds: string[],
	opts: {
		workflowExecutionId: string;
		spanId?: string;
		sessionId?: string;
		limit?: number;
		offset?: number;
	}
): Promise<ObservabilityLlmSpan[]> {
	const sanitized = sanitizeTraceIds(traceIds);
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	const clauses = [`TraceId IN (${inClause})`];
	const workflowExecutionId = opts.workflowExecutionId.trim();
	if (!workflowExecutionId) return [];
	clauses.push(
		`WorkflowExecutionId = '${escapeClickHouseString(workflowExecutionId)}'`
	);
	if (opts.spanId?.trim()) {
		clauses.push(`SpanId = '${escapeClickHouseString(opts.spanId.trim())}'`);
	}
	if (opts.sessionId?.trim()) {
		clauses.push(`SessionId = '${escapeClickHouseString(opts.sessionId.trim())}'`);
	}
	const limit = Math.min(51, Math.max(1, opts.limit ?? 21));
	const offset = Math.max(0, opts.offset ?? 0);
	const rows = await queryClickHouse(`
		SELECT
			Timestamp,
			TraceId,
			SpanId,
			ParentSpanId,
			ServiceName,
			SessionId,
			WorkflowExecutionId,
			AgentRunId,
			ModelName,
			Provider,
			InputMessages,
			OutputMessages,
			InvocationParameters,
			FinishReason,
			PromptTokens,
			CompletionTokens,
			TotalTokens,
			CacheReadInputTokens,
			CacheCreationInputTokens,
			ReasoningTokens,
			StatusCode,
			InputMessagesTruncated,
			OutputMessagesTruncated,
			InvocationParametersTruncated
		FROM ${CLICKHOUSE_OBS_DB}.llm_spans
		WHERE ${clauses.join(' AND ')}
		ORDER BY Timestamp ASC, TraceId ASC, SpanId ASC
		LIMIT ${limit}
		OFFSET ${offset}
	`);
	return rows.map(mapObservabilityLlmSpan);
}

export async function getSessionTraceSpans(sessionId: string): Promise<ObservabilityTraceSpan[]> {
	const traceIds = await getSessionTraceIds(sessionId);
	return getMultiTraceSpans(traceIds);
}

export async function getTraceLlmSpans(traceId: string): Promise<ObservabilityLlmSpan[]> {
	return queryObservabilityLlmSpans(`WHERE TraceId = '${escapeClickHouseString(traceId)}'`);
}

export async function getTraceToolSpans(traceId: string): Promise<ObservabilityToolSpan[]> {
	return queryObservabilityToolSpans(`WHERE TraceId = '${escapeClickHouseString(traceId)}'`);
}

export async function getMultiTraceLlmSpans(
	traceIds: string[],
	serviceNames?: string[],
	window: TraceTimeWindow = {}
): Promise<ObservabilityLlmSpan[]> {
	const sanitized = sanitizeTraceIds(traceIds);
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	return queryObservabilityLlmSpans(
		`WHERE TraceId IN (${inClause}) ${serviceNameClause(serviceNames)} ${traceTimeWindowClause(window)}`
	);
}

/** Token-only projection for service-graph insights. Message bodies and invocation
 * parameters are loaded by investigation views, never by the graph. */
export async function getMultiTraceGraphLlmSpans(
	traceIds: string[],
	window: TraceTimeWindow = {}
): Promise<GraphLlmSpan[]> {
	const sanitized = [...new Set(sanitizeTraceIds(traceIds))];
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	return queryGraphLlmSpans(`WHERE TraceId IN (${inClause}) ${traceTimeWindowClause(window)}`);
}

export type DigestLlmSpanBatch = {
	spans: GraphLlmSpan[];
	truncated: boolean;
	limit: number;
};

/** Capped token-only projection for deterministic run digests. */
export async function getMultiTraceDigestLlmSpans(
	traceIds: string[],
	window: TraceTimeWindow = {},
	requestedLimit = Number(process.env.TRACE_DIGEST_LLM_LIMIT) || 20_000
): Promise<DigestLlmSpanBatch> {
	const sanitized = [...new Set(sanitizeTraceIds(traceIds))];
	const limit = Math.min(50_000, Math.max(1, Math.floor(requestedLimit)));
	if (sanitized.length === 0) return { spans: [], truncated: false, limit };
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	const rows = await queryGraphLlmSpans(
		`WHERE TraceId IN (${inClause}) ${traceTimeWindowClause(window)}`,
		{ limit: limit + 1 }
	);
	return { spans: rows.slice(0, limit), truncated: rows.length > limit, limit };
}

export async function getMultiTraceToolSpans(
	traceIds: string[],
	serviceNames?: string[],
	window: TraceTimeWindow = {}
): Promise<ObservabilityToolSpan[]> {
	const sanitized = sanitizeTraceIds(traceIds);
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	return queryObservabilityToolSpans(
		`WHERE TraceId IN (${inClause}) ${serviceNameClause(serviceNames)} ${traceTimeWindowClause(window)}`
	);
}

export async function getSessionLlmSpans(sessionId: string): Promise<ObservabilityLlmSpan[]> {
	return queryObservabilityLlmSpans(
		`WHERE SessionId = '${escapeClickHouseString(sessionId.trim())}'`
	);
}

export async function getSessionToolSpans(sessionId: string): Promise<ObservabilityToolSpan[]> {
	return queryObservabilityToolSpans(
		`WHERE SessionId = '${escapeClickHouseString(sessionId.trim())}'`
	);
}

/**
 * Recursively extract all traceIds from execution output.
 * Mirrors the Next.js extractExecutionTraceIds + buildCandidateRecords pattern.
 */
export function extractExecutionTraceIds(output: unknown): string[] {
	const ids = new Set<string>();
	for (const record of buildCandidateRecords(output)) {
		const traceId = readTraceIdFromRecord(record);
		if (traceId) ids.add(traceId);
	}
	return Array.from(ids);
}

/**
 * Find correlated trace IDs by time window from services that don't
 * propagate trace context through Dapr workflow boundaries. Searches
 * ClickHouse for traces from LLM-related services within the execution's
 * time window.
 */
export async function findCorrelatedTraceIds(
	startedAt: string | Date,
	completedAt: string | Date | null,
	knownTraceIds: string[] = []
): Promise<string[]> {
	try {
		const start = new Date(startedAt);
		// Add buffer: 5s before start, 10s after end (or now if still running)
		const startBuf = new Date(start.getTime() - 5000)
			.toISOString()
			.replace('T', ' ')
			.replace('Z', '');
		const end = completedAt ? new Date(new Date(completedAt).getTime() + 10000) : new Date();
		const endBuf = end.toISOString().replace('T', ' ').replace('Z', '');

		const knownExclude =
			knownTraceIds.length > 0
				? `AND TraceId NOT IN (${knownTraceIds.map((id) => `'${id}'`).join(', ')})`
				: '';

		const rows = await queryClickHouse(`
			SELECT DISTINCT TraceId
			FROM ${CLICKHOUSE_DB}.otel_traces
			WHERE Timestamp >= '${startBuf}'
			  AND Timestamp <= '${endBuf}'
			  AND ServiceName IN ('function-router', 'dapr-agent-py')
			  ${knownExclude}
			ORDER BY TraceId
		`);

		return rows.map((r) => r.TraceId as string);
	} catch {
		return [];
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readTraceIdFromRecord(record: Record<string, unknown>): string | undefined {
	if (typeof record.traceId === 'string' && record.traceId.trim()) {
		return record.traceId.trim();
	}
	const progress = isRecord(record.agentProgress) ? record.agentProgress : null;
	if (progress && typeof progress.traceId === 'string' && progress.traceId.trim()) {
		return progress.traceId.trim();
	}
	return undefined;
}

/**
 * Recursively walks execution output, following `data` and `result` properties,
 * plus the `outputs` map (nodeKey → output). Collects all records that might
 * contain a traceId.
 */
function buildCandidateRecords(output: unknown): Record<string, unknown>[] {
	const root = isRecord(output) ? output : null;
	if (!root) return [];

	const candidates: Record<string, unknown>[] = [];
	const seen = new WeakSet<object>();

	function pushRecord(record: Record<string, unknown>) {
		const queue: Record<string, unknown>[] = [record];
		while (queue.length > 0) {
			const current = queue.shift()!;
			if (seen.has(current)) continue;
			seen.add(current);
			candidates.push(current);
			// Follow nested data/result chains
			for (const key of ['data', 'result']) {
				const nested = isRecord(current[key]) ? (current[key] as Record<string, unknown>) : null;
				if (nested && !seen.has(nested)) queue.push(nested);
			}
		}
	}

	pushRecord(root);

	// Walk outputs map (each nodeKey's output may contain traceIds)
	const outputs = isRecord(root.outputs) ? root.outputs : null;
	if (outputs) {
		for (const value of Object.values(outputs)) {
			if (isRecord(value)) pushRecord(value);
		}
	}

	return candidates;
}

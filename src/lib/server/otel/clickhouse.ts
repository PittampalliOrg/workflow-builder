import { env } from '$env/dynamic/private';
import type {
	ObservabilityLlmSpan,
	ObservabilityLogEntry,
	ObservabilityToolSpan,
	ObservabilityTraceSpan
} from '$lib/types/observability';

export const CLICKHOUSE_URL = env.CLICKHOUSE_URL ?? 'http://otel-clickhouse.observability.svc.cluster.local:8123';
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

export async function queryClickHouse(sql: string): Promise<Record<string, unknown>[]> {
	const res = await fetch(
		`${CLICKHOUSE_URL}/?user=${encodeURIComponent(CLICKHOUSE_USER)}&password=${encodeURIComponent(CLICKHOUSE_PASSWORD)}`,
		{ method: 'POST', body: `${sql} FORMAT JSONEachRow` }
	);
	if (!res.ok) throw new Error(`ClickHouse error: ${res.status}`);
	const text = await res.text();
	if (!text.trim()) return [];
	return text.trim().split('\n').map((line) => JSON.parse(line));
}

export function escapeClickHouseString(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

export function sanitizeTraceIds(traceIds: string[]): string[] {
	return traceIds
		.filter((id) => typeof id === 'string' && /^[a-f0-9]+$/i.test(id.trim()))
		.map((id) => id.trim());
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

function mapObservabilityTraceSpan(row: Record<string, unknown>): Omit<ObservabilityTraceSpan, 'depth'> {
	return {
		traceId: String(row.TraceId ?? ''),
		spanId: String(row.SpanId ?? ''),
		parentSpanId: row.ParentSpanId ? String(row.ParentSpanId) : null,
		operationName: String(row.SpanName ?? ''),
		serviceName: String(row.ServiceName ?? 'unknown'),
		startTime: String(row.Timestamp ?? ''),
		duration: Math.round(Number(row.DurationMs ?? 0)),
		statusCode: row.StatusCode ? String(row.StatusCode) : undefined,
		statusMessage: row.StatusMessage ? String(row.StatusMessage) : undefined,
		spanKind: row.SpanKind ? String(row.SpanKind) : undefined,
		attributes: (row.SpanAttributes as Record<string, unknown>) ?? {},
		resourceAttributes: (row.ResourceAttributes as Record<string, unknown>) ?? {},
		status: String(row.StatusCode ?? '') === 'STATUS_CODE_ERROR' ? 'error' : 'ok'
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

function enrichTraceDepths(spans: Omit<ObservabilityTraceSpan, 'depth'>[]): ObservabilityTraceSpan[] {
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

export async function getTraceLogs(traceId: string): Promise<ObservabilityLogEntry[]> {
	return queryObservabilityLogs(
		`WHERE TraceId = '${escapeClickHouseString(traceId)}'`
	);
}

export async function getMultiTraceLogs(traceIds: string[]): Promise<ObservabilityLogEntry[]> {
	const sanitized = sanitizeTraceIds(traceIds);
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	return queryObservabilityLogs(`WHERE TraceId IN (${inClause})`);
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

export async function getMultiTraceSpans(traceIds: string[]): Promise<ObservabilityTraceSpan[]> {
	const sanitized = sanitizeTraceIds(traceIds);
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	return queryTraceSpans(`WHERE TraceId IN (${inClause})`);
}

export async function getSessionTraceSpans(sessionId: string): Promise<ObservabilityTraceSpan[]> {
	const traceIds = await getSessionTraceIds(sessionId);
	return getMultiTraceSpans(traceIds);
}

export async function getTraceLlmSpans(traceId: string): Promise<ObservabilityLlmSpan[]> {
	return queryObservabilityLlmSpans(
		`WHERE TraceId = '${escapeClickHouseString(traceId)}'`
	);
}

export async function getTraceToolSpans(traceId: string): Promise<ObservabilityToolSpan[]> {
	return queryObservabilityToolSpans(
		`WHERE TraceId = '${escapeClickHouseString(traceId)}'`
	);
}

export async function getMultiTraceLlmSpans(
	traceIds: string[]
): Promise<ObservabilityLlmSpan[]> {
	const sanitized = sanitizeTraceIds(traceIds);
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	return queryObservabilityLlmSpans(`WHERE TraceId IN (${inClause})`);
}

export async function getMultiTraceToolSpans(
	traceIds: string[]
): Promise<ObservabilityToolSpan[]> {
	const sanitized = sanitizeTraceIds(traceIds);
	if (sanitized.length === 0) return [];
	const inClause = sanitized.map((id) => `'${escapeClickHouseString(id)}'`).join(', ');
	return queryObservabilityToolSpans(`WHERE TraceId IN (${inClause})`);
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
 * Find correlated trace IDs by time window from services like dapr-swe
 * that don't propagate trace context through Dapr workflow boundaries.
 * Searches ClickHouse for traces from LLM-related services within the
 * execution's time window.
 */
export async function findCorrelatedTraceIds(
	startedAt: string | Date,
	completedAt: string | Date | null,
	knownTraceIds: string[] = []
): Promise<string[]> {
	try {
		const start = new Date(startedAt);
		// Add buffer: 5s before start, 10s after end (or now if still running)
		const startBuf = new Date(start.getTime() - 5000).toISOString().replace('T', ' ').replace('Z', '');
		const end = completedAt ? new Date(new Date(completedAt).getTime() + 10000) : new Date();
		const endBuf = end.toISOString().replace('T', ' ').replace('Z', '');

		const knownExclude = knownTraceIds.length > 0
			? `AND TraceId NOT IN (${knownTraceIds.map(id => `'${id}'`).join(', ')})`
			: '';

		const rows = await queryClickHouse(`
			SELECT DISTINCT TraceId
			FROM ${CLICKHOUSE_DB}.otel_traces
			WHERE Timestamp >= '${startBuf}'
			  AND Timestamp <= '${endBuf}'
			  AND ServiceName IN ('dapr-swe', 'function-router', 'dapr-agent-py', 'workspace-runtime')
			  ${knownExclude}
			ORDER BY TraceId
		`);

		return rows.map(r => r.TraceId as string);
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

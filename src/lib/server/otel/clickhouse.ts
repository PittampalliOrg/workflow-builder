import { env } from '$env/dynamic/private';

export const CLICKHOUSE_URL = env.CLICKHOUSE_URL ?? 'http://otel-clickhouse.observability.svc.cluster.local:8123';
export const CLICKHOUSE_USER = env.CLICKHOUSE_USER ?? 'default';
export const CLICKHOUSE_PASSWORD = env.CLICKHOUSE_PASSWORD ?? 'otel_dev_password';
export const CLICKHOUSE_DB = env.CLICKHOUSE_DB ?? 'otel';

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
			  AND ServiceName IN ('dapr-swe', 'function-router', 'durable-agent')
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

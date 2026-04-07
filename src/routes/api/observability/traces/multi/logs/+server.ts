import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getMultiTraceLogs } from '$lib/server/otel/clickhouse';

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const traceIds: string[] = Array.isArray(body.traceIds) ? body.traceIds : [];

	try {
		const logs = await getMultiTraceLogs(traceIds);
		return json({
			traceIds,
			logs,
			logCount: logs.length
		});
	} catch (err) {
		return json({
			traceIds,
			logs: [],
			logCount: 0,
			error: `Failed to query ClickHouse: ${err instanceof Error ? err.message : String(err)}`
		});
	}
};

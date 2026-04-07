import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSessionLogs } from '$lib/server/otel/clickhouse';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const logs = await getSessionLogs(params.sessionId);
		return json({
			sessionId: params.sessionId,
			logs,
			logCount: logs.length
		});
	} catch (err) {
		return json({
			sessionId: params.sessionId,
			logs: [],
			logCount: 0,
			error: `Failed to query ClickHouse: ${err instanceof Error ? err.message : String(err)}`
		});
	}
};

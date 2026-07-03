import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getTraceLogs } from '$lib/server/otel/clickhouse';
import { assertTraceInScope } from '../trace-access';

export const GET: RequestHandler = async ({ params, locals }) => {
	await assertTraceInScope(params.traceId, locals.session);
	try {
		const logs = await getTraceLogs(params.traceId);
		return json({
			traceId: params.traceId,
			logs,
			logCount: logs.length
		});
	} catch (err) {
		return json({
			traceId: params.traceId,
			logs: [],
			logCount: 0,
			error: `Failed to query ClickHouse: ${err instanceof Error ? err.message : String(err)}`
		});
	}
};

import { json, isHttpError } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getTraceLogs, isClickHouseConfigured } from '$lib/server/otel/clickhouse';
import { assertTraceInScope } from '../trace-access';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!isClickHouseConfigured()) {
		return json({ configured: false, traceId: params.traceId, logs: [], logCount: 0 }, { status: 503 });
	}
	try {
		// assertTraceInScope queries ClickHouse, so it lives inside the try — an
		// unreachable-but-configured ClickHouse degrades to 503, scope rejections
		// (HttpError) still propagate.
		await assertTraceInScope(params.traceId, locals.session);
		const logs = await getTraceLogs(params.traceId);
		return json({
			traceId: params.traceId,
			logs,
			logCount: logs.length
		});
	} catch (err) {
		if (isHttpError(err)) throw err;
		return json(
			{
				configured: true,
				available: false,
				traceId: params.traceId,
				logs: [],
				logCount: 0,
				error: `Failed to query ClickHouse: ${err instanceof Error ? err.message : String(err)}`
			},
			{ status: 503 }
		);
	}
};

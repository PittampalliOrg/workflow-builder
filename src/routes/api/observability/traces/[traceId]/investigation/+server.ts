import { json, isHttpError } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildTraceInvestigation } from '$lib/server/observability/investigation';
import { isClickHouseConfigured } from '$lib/server/otel/clickhouse';
import { assertTraceInScope } from '../trace-access';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!isClickHouseConfigured()) {
		return json({ configured: false, available: false, error: 'ClickHouse not configured' }, { status: 503 });
	}
	try {
		// assertTraceInScope + the investigation build both hit ClickHouse, so they
		// live inside the try — an unreachable-but-configured ClickHouse degrades to
		// 503, scope rejections (HttpError) still propagate.
		await assertTraceInScope(params.traceId, locals.session);
		const payload = await buildTraceInvestigation(params.traceId);
		return json(payload);
	} catch (err) {
		if (isHttpError(err)) throw err;
		return json(
			{
				configured: true,
				available: false,
				error: `Failed to build investigation payload: ${err instanceof Error ? err.message : String(err)}`
			},
			{ status: 503 }
		);
	}
};

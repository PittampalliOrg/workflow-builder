import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildTraceInvestigation } from '$lib/server/observability/investigation';
import { isClickHouseConfigured } from '$lib/server/otel/clickhouse';
import { assertTraceInScope } from '../trace-access';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!isClickHouseConfigured()) {
		return json({ configured: false, error: 'ClickHouse not configured' }, { status: 503 });
	}
	await assertTraceInScope(params.traceId, locals.session);
	try {
		const payload = await buildTraceInvestigation(params.traceId);
		return json(payload);
	} catch (err) {
		return json(
			{
				error: `Failed to build investigation payload: ${err instanceof Error ? err.message : String(err)}`
			},
			{ status: 500 }
		);
	}
};

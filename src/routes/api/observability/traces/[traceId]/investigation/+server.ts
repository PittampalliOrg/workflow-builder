import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildTraceInvestigation } from '$lib/server/observability/investigation';
import { assertTraceInScope } from '$lib/server/observability/trace-scope';

export const GET: RequestHandler = async ({ params, locals }) => {
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

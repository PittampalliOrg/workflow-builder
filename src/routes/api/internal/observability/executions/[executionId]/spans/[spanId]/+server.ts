import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { guardAnalystAccess } from '../../guard';

/** Exact generic span detail, including bounded/redacted tool and MCP IO attributes. */
export const GET: RequestHandler = async ({ params, request }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	const result = await getApplicationAdapters().workflowDiagnostics.getSpan({
		execution: guard.execution,
		spanId: params.spanId
	});
	return json(result.body, { status: result.httpStatus ?? 200 });
};

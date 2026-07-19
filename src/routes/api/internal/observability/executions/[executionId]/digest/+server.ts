import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { guardAnalystAccess } from '../guard';

/** GET — workspace-scoped RunDigest for the trace-analyst MCP tool. */
export const GET: RequestHandler = async ({ params, request }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	const result = await getApplicationAdapters().workflowDiagnostics.getDigest({
		execution: guard.execution
	});
	return json(result.body, { status: result.httpStatus ?? 200 });
};

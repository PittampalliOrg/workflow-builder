import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { buildRunDigestForExecution } from '$lib/server/observability/run-digest-loader';
import { guardAnalystAccess } from '../guard';

/** GET — RunDigest for the trace-analyst MCP tool (internal token + session scope). */
export const GET: RequestHandler = async ({ params, request }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	return json(await buildRunDigestForExecution(guard.execution));
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { validateInternalToken } from '$lib/server/internal-auth';

type Body = {
	toolName?: unknown;
	input?: unknown;
};

function traceHeadersFromRequest(request: Request): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const name of ['traceparent', 'tracestate', 'baggage']) {
		const value = request.headers.get(name);
		if (value) headers[name] = value;
	}
	return headers;
}

/**
 * POST /api/internal/mcp/projects/[projectId]/tools/[workflowId]/execute
 *
 * Starts a workflow tool execution for mcp-gateway. Persistence, validation,
 * and scheduler dispatch live behind workflow-data application ports.
 */
export const POST: RequestHandler = async ({ request, params }) => {
	if (!validateInternalToken(request)) {
		return error(401, 'Unauthorized');
	}

	const body = (await request.json().catch(() => ({}))) as Body;
	const result = await getApplicationAdapters().workflowData.startHostedMcpWorkflowTool({
		projectId: params.projectId,
		workflowId: params.workflowId,
		toolName: body.toolName,
		input: body.input ?? {},
		traceHeaders: traceHeadersFromRequest(request)
	});
	if (!result.ok) return error(result.status, result.message);

	return json({
		runId: result.runId,
		executionId: result.executionId,
		instanceId: result.instanceId,
		returnsResponse: result.returnsResponse
	});
};

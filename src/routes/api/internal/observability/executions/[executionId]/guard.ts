import { json } from '@sveltejs/kit';
import { validateInternalToken } from '$lib/server/internal-auth';
import { getApplicationAdapters } from '$lib/server/application';
import { resolveInternalWorkflowPrincipal } from '../../../workflow-mcp-principal';

/**
 * Shared guard for the internal observability routes behind the trace-analyst
 * MCP tools. The service token authenticates the MCP server, while the signed
 * workflow principal authorizes the caller's workspace and workflow:read scope.
 */
type GuardExecution = NonNullable<
	Awaited<
		ReturnType<
			ReturnType<typeof getApplicationAdapters>['workflowData']['getScopedExecutionById']
		>
	>
>;

type GuardResult =
	| { ok: false; res: Response }
	| { ok: true; execution: GuardExecution };

export async function guardAnalystAccess(
	request: Request,
	executionId: string
): Promise<GuardResult> {
	if (!validateInternalToken(request)) {
		return { ok: false, res: json({ error: 'unauthorized' }, { status: 401 }) };
	}

	const app = getApplicationAdapters();
	const principalResult = await resolveInternalWorkflowPrincipal(
		request,
		app.internalWorkflowPrincipal,
		{ requiredScope: 'workflow:read' }
	);
	if (!principalResult.ok) {
		return {
			ok: false,
			res: json({ error: principalResult.error }, { status: principalResult.status })
		};
	}

	const execution = await app.workflowData.getScopedExecutionById({
		executionId,
		userId: principalResult.principal.userId,
		projectId: principalResult.principal.projectId
	});
	if (!execution) {
		return {
			ok: false,
			res: json({ error: `Execution ${executionId} not found in this workspace` }, { status: 404 })
		};
	}
	return { ok: true, execution };
}

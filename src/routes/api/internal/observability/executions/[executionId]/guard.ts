import { json } from '@sveltejs/kit';
import { validateInternalToken } from '$lib/server/internal-auth';
import { getApplicationAdapters } from '$lib/server/application';

/**
 * Shared guard for the internal observability routes behind the trace-analyst
 * MCP tools: INTERNAL_API_TOKEN + X-Wfb-Session-Id whose project matches the
 * execution's project — an analyst session can only read runs in its own
 * workspace.
 */
type GuardContext = NonNullable<
	Awaited<
		ReturnType<
			ReturnType<typeof getApplicationAdapters>['workflowData']['getObservabilityServiceGraphContext']
		>
	>
>;

type GuardResult =
	| { ok: false; res: Response }
	| { ok: true; execution: NonNullable<GuardContext['execution']> };

export async function guardAnalystAccess(
	request: Request,
	executionId: string
): Promise<GuardResult> {
	if (!validateInternalToken(request)) {
		return { ok: false, res: json({ error: 'unauthorized' }, { status: 401 }) };
	}
	const sessionId = request.headers.get('x-wfb-session-id') ?? '';
	if (!sessionId) {
		return {
			ok: false,
			res: json({ error: 'X-Wfb-Session-Id header is required' }, { status: 400 })
		};
	}
	const app = getApplicationAdapters();
	const owner = await app.workflowData.getSessionFileOwner(sessionId).catch(() => null);
	if (!owner) {
		return { ok: false, res: json({ error: `Session ${sessionId} not found` }, { status: 404 }) };
	}
	const execution = await app.workflowData
		.getObservabilityServiceGraphContext({
			userId: owner.userId,
			projectId: owner.projectId ?? null,
			executionId
		})
		.then((ctx) => ctx?.execution ?? null)
		.catch(() => null);
	if (!execution) {
		return {
			ok: false,
			res: json({ error: `Execution ${executionId} not found in this workspace` }, { status: 404 })
		};
	}
	return { ok: true, execution };
}

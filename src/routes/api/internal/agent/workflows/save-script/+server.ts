import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { getApplicationAdapters } from '$lib/server/application';
import { extractStaticMeta } from '$lib/server/workflows/dynamic-script-validation';

// ---------------------------------------------------------------------------
// POST /api/internal/agent/workflows/save-script
//
// Save (upsert) a REUSABLE dynamic-script workflow WITHOUT starting a run —
// the persistence half of the agent authoring loop (author → validate → SAVE
// → run-by-name). The workflow-mcp-server `save_workflow_script` tool calls
// this; the legacy `create_workflow` MCP tool creates SW canvas workflows and
// cannot carry a script.
//
// Upsert semantics: an existing dynamic-script workflow with the same name in
// the SAME project is updated in place (updateWorkflow re-validates + stamps
// evaluator-truth meta); a same-name workflow in another project or of another
// engine type is left alone and a fresh one is created.
//
// Auth: INTERNAL_API_TOKEN via X-Internal-Token. X-Wfb-Session-Id REQUIRED —
// the saved workflow is owned by the spawning session's user + project.
// Body: { script, name? }   (name defaults to the script's meta.name)
// Returns: { workflowId, name, action: "created" | "updated" }
// ---------------------------------------------------------------------------

type SaveScriptBody = {
	script?: string;
	name?: string;
};

export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json().catch(() => ({}))) as SaveScriptBody;
	const script = typeof body.script === 'string' ? body.script : '';
	if (!script.trim()) {
		return json({ error: 'script is required' }, { status: 400 });
	}

	const app = getApplicationAdapters();

	const sessionId = request.headers.get('x-wfb-session-id') ?? '';
	if (!sessionId) {
		return json(
			{ error: 'X-Wfb-Session-Id header is required to attribute a saved workflow' },
			{ status: 400 }
		);
	}
	let owner: { id: string; userId: string; projectId: string | null } | null;
	try {
		owner = await app.workflowData.getSessionFileOwner(sessionId);
	} catch (err) {
		if (err instanceof Error && err.message === 'Database not configured') {
			return json({ error: 'Database not configured' }, { status: 503 });
		}
		throw err;
	}
	if (!owner) {
		return json({ error: `Session ${sessionId} not found` }, { status: 404 });
	}
	if (!owner.projectId) {
		return json(
			{ error: 'Spawning session has no project scope; cannot save a workflow' },
			{ status: 400 }
		);
	}

	const staticMeta = extractStaticMeta(script) ?? { name: 'Saved dynamic script' };
	const name =
		typeof body.name === 'string' && body.name.trim() ? body.name.trim() : staticMeta.name;
	const spec = { engine: 'dynamic-script', script, meta: staticMeta };

	// Upsert: update in place only when the same-name workflow is a
	// dynamic-script one in the SAME project (never clobber other projects'
	// or canvas workflows).
	const existing = await app.workflowData.getWorkflowByRef({
		workflowName: name,
		lookup: 'name'
	});
	const existingRecord = existing as
		| { id: string; engineType?: string | null; projectId?: string | null }
		| null;
	if (
		existingRecord &&
		existingRecord.engineType === 'dynamic-script' &&
		existingRecord.projectId === owner.projectId
	) {
		const updated = await app.workflowDefinitionCommands.updateWorkflow({
			workflowId: existingRecord.id,
			body: { name, engineType: 'dynamic-script', spec }
		});
		if (updated.status === 'error') {
			const message =
				typeof updated.body === 'string' ? updated.body : JSON.stringify(updated.body);
			return json({ error: message }, { status: updated.httpStatus });
		}
		return json({ workflowId: existingRecord.id, name, action: 'updated' });
	}

	const created = await app.workflowDefinitionCommands.createWorkflow({
		body: {
			name,
			nodes: [],
			edges: [],
			engineType: 'dynamic-script',
			spec
		},
		userId: owner.userId,
		projectId: owner.projectId
	});
	if (created.status === 'error') {
		const message =
			typeof created.body === 'string' ? created.body : JSON.stringify(created.body);
		return json({ error: message }, { status: created.httpStatus });
	}
	const workflow = created.body as { id: string };
	return json({ workflowId: workflow.id, name, action: 'created' });
};

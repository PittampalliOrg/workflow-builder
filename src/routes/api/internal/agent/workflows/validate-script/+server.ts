import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateInternalToken } from '$lib/server/internal-auth';
import { validateWithEvaluator } from '$lib/server/workflows/dynamic-script-validation';

// ---------------------------------------------------------------------------
// POST /api/internal/agent/workflows/validate-script
//
// Author-time validation for the workflow-mcp-server `validate_workflow_script`
// tool: an agent can check a dynamic-script source for syntactic correctness +
// resolve its `meta`/`estimatedAgentCalls` BEFORE running it. Delegates to the
// authoritative `validateWithEvaluator` (static gate → script-evaluator /validate,
// degrading to the static gate when the evaluator is unreachable).
//
// Auth: requires INTERNAL_API_TOKEN via X-Internal-Token header.
// Body: { script }
// Returns 200 { ok: true, meta, estimatedAgentCalls } on success, or
//         200 { ok: false, error } on a validation failure (NOT an HTTP error —
//         the caller wants the reason, not an exception).
// ---------------------------------------------------------------------------

type ValidateScriptBody = { script?: string };

export const POST: RequestHandler = async ({ request }) => {
	if (!validateInternalToken(request)) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const body = (await request.json().catch(() => ({}))) as ValidateScriptBody;
	const script = typeof body.script === 'string' ? body.script : '';
	if (!script.trim()) {
		return json({ ok: false, error: 'script is required' }, { status: 400 });
	}

	const result = await validateWithEvaluator(script);
	if (result.ok) {
		return json({
			ok: true,
			meta: result.meta,
			estimatedAgentCalls: result.estimatedAgentCalls ?? result.meta.estimatedAgentCalls
		});
	}
	// Validation failure is a normal, expected outcome for an authoring loop — return
	// 200 with ok:false so the tool surfaces the reason rather than throwing.
	return json({ ok: false, error: result.error });
};

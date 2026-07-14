import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateWithEvaluator } from '$lib/server/workflows/dynamic-script-validation';

/**
 * Live-editor validation (code-first authoring): validate a dynamic-script
 * WITHOUT saving it. Same evaluator-truth check the save path runs
 * (validateAndStampDynamicScript), exposed to the signed-in editor so the
 * code⇄canvas split view can show errors as you type.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.session?.userId) return error(401, 'Authentication required');
	const body = (await request.json().catch(() => ({}))) as { script?: unknown };
	const script = typeof body.script === 'string' ? body.script : '';
	if (!script.trim()) {
		return json({ ok: false, error: 'script must be a non-empty string' }, { status: 400 });
	}
	const result = await validateWithEvaluator(script);
	if (!result.ok) {
		// Validation failures are a NORMAL editor state, not an HTTP error.
		return json({ ok: false, error: result.error });
	}
	return json({
		ok: true,
		meta: result.meta ?? null,
		estimatedAgentCalls: result.estimatedAgentCalls ?? null
	});
};

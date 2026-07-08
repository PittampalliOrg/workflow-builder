import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { loadExecutionTraceBundle } from '$lib/server/observability/run-digest-loader';
import { guardAnalystAccess } from '../guard';

/**
 * GET ?spanId= | ?sessionId= — full LLM turn content (input/output messages,
 * model, tokens) for one span, or the turn list for a session. This is the
 * analyst's "what did the agent actually see/say" tool.
 */
export const GET: RequestHandler = async ({ params, request, url }) => {
	const guard = await guardAnalystAccess(request, params.executionId);
	if (!guard.ok) return guard.res;
	const spanId = url.searchParams.get('spanId');
	const sessionId = url.searchParams.get('sessionId');
	if (!spanId && !sessionId) {
		return json({ error: 'spanId or sessionId is required' }, { status: 400 });
	}
	const { llmSpans } = await loadExecutionTraceBundle(guard.execution);
	const matches = llmSpans.filter((s) =>
		spanId ? s.spanId === spanId : s.sessionId === sessionId
	);
	return json({
		turns: matches.map((s) => ({
			spanId: s.spanId,
			traceId: s.traceId,
			sessionId: s.sessionId,
			model: s.modelName ?? null,
			promptTokens: s.promptTokens ?? null,
			completionTokens: s.completionTokens ?? null,
			cacheReadInputTokens: s.cacheReadInputTokens ?? null,
			finishReason: s.finishReason ?? null,
			inputMessages: s.inputMessages,
			outputMessages: s.outputMessages
		}))
	});
};

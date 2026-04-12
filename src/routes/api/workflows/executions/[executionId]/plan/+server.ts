import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * GET /api/workflows/executions/[executionId]/plan
 *
 * Fetches the plan content from the dapr-agent-py state store.
 * The agent persists plans at key "plan:{executionId}" after writing PLAN.md.
 */
export const GET: RequestHandler = async ({ params, fetch: svelteFetch }) => {
	const { executionId } = params;

	const DAPR_HOST = process.env.DAPR_HOST || '127.0.0.1';
	const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || '3500';
	const STORE = 'dapr-agent-py-statestore';
	const key = `plan:${executionId}`;

	try {
		const stateUrl = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/state/${STORE}/${encodeURIComponent(key)}`;
		const res = await fetch(stateUrl, {
			headers: { 'Content-Type': 'application/json' }
		});

		if (res.status === 204 || !res.ok) {
			// No plan found in state store
			return json({ plan: null });
		}

		const raw = await res.text();
		if (!raw || raw === '""' || raw === 'null') {
			return json({ plan: null });
		}

		// The state store returns JSON-encoded string
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return json({ plan: raw });
		}

		// Handle double-encoded JSON (state store wraps in quotes)
		if (typeof parsed === 'string') {
			try {
				parsed = JSON.parse(parsed);
			} catch {
				return json({ plan: parsed });
			}
		}

		if (typeof parsed === 'object' && parsed !== null && 'plan' in parsed) {
			return json({ plan: (parsed as { plan: string }).plan });
		}

		return json({ plan: typeof parsed === 'string' ? parsed : JSON.stringify(parsed) });
	} catch (err) {
		// State store not accessible — not critical
		return json({ plan: null });
	}
};

import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';

/**
 * Batch sandbox operations.
 * POST body: { action: 'delete', names: string[] }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const action = body.action;
	const names: string[] = body.names ?? [];

	if (!action || names.length === 0) {
		return error(400, 'Missing action or names');
	}

	if (names.length > 50) {
		return error(400, 'Maximum 50 sandboxes per batch operation');
	}

	if (action === 'delete') {
		const results = await Promise.allSettled(
			names.map(async (name) => {
				const res = await openshellRuntimeFetch(
					`/api/v1/sandboxes/${encodeURIComponent(name)}`,
					{ method: 'DELETE' }
				);
				return { name, ok: res.ok, status: res.status };
			})
		);

		const summary = results.map((r, i) => ({
			name: names[i],
			ok: r.status === 'fulfilled' ? r.value.ok : false,
			error: r.status === 'rejected' ? String(r.reason) : undefined
		}));

		return json({
			action: 'delete',
			total: names.length,
			succeeded: summary.filter((s) => s.ok).length,
			failed: summary.filter((s) => !s.ok).length,
			results: summary
		});
	}

	return error(400, `Unknown action: ${action}`);
};

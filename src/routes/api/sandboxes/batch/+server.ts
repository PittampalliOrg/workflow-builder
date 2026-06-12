import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';
import { activeSessionForSandboxName } from '$lib/server/sandboxes/active-session-guard';

/**
 * Batch sandbox operations.
 * POST body: { action: 'delete', names: string[] }
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	// Authenticated only — bulk-reaps Sandbox CRs (irreversible pod teardown).
	if (!locals.session?.userId) return error(401, 'Authentication required');

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
		// Skip any name backing a LIVE session (out-of-band reap = DB↔Dapr divergence,
		// the hazard the lifecycle SSOT prevents) — stop the run first. Report them as
		// skipped rather than failing the whole batch.
		const guards = await Promise.all(names.map((name) => activeSessionForSandboxName(name)));
		const skipped = new Set<string>();
		names.forEach((name, i) => {
			// Reaping a sandbox that backs a live session is always wrong (in-scope or
			// not — for out-of-scope we additionally must not touch another workspace's).
			if (guards[i].active) skipped.add(name);
		});

		const deletable = names.filter((name) => !skipped.has(name));
		const results = await Promise.allSettled(
			deletable.map(async (name) => {
				const res = await openshellRuntimeFetch(
					`/api/v1/sandboxes/${encodeURIComponent(name)}`,
					{ method: 'DELETE' }
				);
				return { name, ok: res.ok, status: res.status };
			})
		);

		const deletedSummary = results.map((r, i) => ({
			name: deletable[i],
			ok: r.status === 'fulfilled' ? r.value.ok : false,
			error: r.status === 'rejected' ? String(r.reason) : undefined
		}));
		const skippedSummary = [...skipped].map((name) => ({
			name,
			ok: false,
			skipped: true,
			error: 'sandbox backs an active session — stop the run first'
		}));
		const summary = [...deletedSummary, ...skippedSummary];

		return json({
			action: 'delete',
			total: names.length,
			succeeded: deletedSummary.filter((s) => s.ok).length,
			skipped: skippedSummary.length,
			failed: deletedSummary.filter((s) => !s.ok).length,
			results: summary
		});
	}

	return error(400, `Unknown action: ${action}`);
};

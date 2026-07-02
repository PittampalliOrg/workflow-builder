import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";
import { listSessions } from "$lib/server/sessions/registry";
import { listRecentRuns } from "$lib/server/workflows/runs";

/**
 * Dashboard home. Greets the user by name + surfaces their five most
 * recent sessions and five most recent workflow runs. Unauthenticated
 * callers still land here — they see the CTA cards but an empty recents
 * strip.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.session?.userId) {
		return { user: null, recentSessions: [], recentRuns: [] };
	}

	const userRow = await getApplicationAdapters()
		.workflowData.getUserProfile(locals.session.userId)
		.catch(() => null);

	const [sessions, runs] = await Promise.all([
		listSessions({
			userId: locals.session.userId,
			projectId: locals.session.projectId,
			limit: 5,
		}).catch(() => []),
		locals.session.projectId
			? listRecentRuns({
					projectId: locals.session.projectId,
					limit: 5,
				}).catch(() => [])
			: Promise.resolve([]),
	]);

	return {
		user: userRow
			? {
					name: userRow.name ?? null,
					email: userRow.email ?? null,
				}
			: null,
		recentSessions: sessions.map((s) => ({
			id: s.id,
			title: s.title ?? null,
			status: s.status,
			agentId: s.agentId,
			updatedAt: s.updatedAt,
		})),
		recentRuns: runs.map((r) => ({
			executionId: r.executionId,
			workflowId: r.workflowId,
			workflowName: r.workflowName,
			status: r.status,
			startedAt: r.startedAt,
			durationMs: r.durationMs,
		})),
	};
};

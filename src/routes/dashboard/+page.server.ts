import type { PageServerLoad } from "./$types";
import { getApplicationAdapters } from "$lib/server/application";

/**
 * Server-loaded operator overview for /dashboard.
 *
 * Every data source is fetched and guarded INDEPENDENTLY so one failing (or
 * empty) source only degrades its own region: the page always returns 200 and
 * each region falls back to a graceful empty state. Data access goes solely
 * through $lib/server/application (hexagonal boundary) — no direct DB/adapter
 * imports from the route.
 *
 * Landmine guard: workspace list endpoints can return DUPLICATE ids (same
 * resource at multiple versions). We dedupe every list here in the load AND
 * the page keys each {#each} by a guaranteed-unique composite, so Svelte 5
 * hydration never throws each_key_duplicate.
 */

type Stats = {
	activeSessions: number;
	sessionsToday: number;
	archivedLast24h: number;
	tokensOut7d: number;
	tokensIn7d: number;
	totalAgents: number;
	totalEnvironments: number;
	totalVaults: number;
};

const EMPTY_STATS: Stats = {
	activeSessions: 0,
	sessionsToday: 0,
	archivedLast24h: 0,
	tokensOut7d: 0,
	tokensIn7d: 0,
	totalAgents: 0,
	totalEnvironments: 0,
	totalVaults: 0,
};

export const load: PageServerLoad = async ({ locals }) => {
	const userId = locals.session?.userId ?? null;
	const projectId = locals.session?.projectId ?? null;

	const adapters = getApplicationAdapters();
	const now = Date.now();
	const dayAgo = now - 24 * 60 * 60 * 1000;

	// ── Region 1+3+4: dashboard read model (counts, sessions, recent changes) ──
	// Guarded on its own; a failure degrades only these regions.
	const dashboardPromise = (async () => {
		if (!userId) return null;
		try {
			return await adapters.workflowData.getDashboard({ userId });
		} catch {
			return null;
		}
	})();

	// ── Region 2: cross-workflow recent runs. Guarded independently. ──
	const runsPromise = (async () => {
		if (!projectId) return [];
		try {
			return await adapters.workflowData.listProjectWorkflowRuns({
				projectId,
				limit: 100,
			});
		} catch {
			return [];
		}
	})();

	const [dashboard, runsRaw] = await Promise.all([dashboardPromise, runsPromise]);

	// Dedupe active sessions by id (landmine: duplicate ids across versions).
	const seenSession = new Set<string>();
	const activeSessions = (dashboard?.activeSessions ?? []).filter((s) => {
		if (seenSession.has(s.id)) return false;
		seenSession.add(s.id);
		return true;
	});

	// Dedupe recent changes by kind+resourceId+version composite.
	const seenChange = new Set<string>();
	const recentChanges = (dashboard?.recentChanges ?? []).filter((c) => {
		const key = `${c.kind}:${c.resourceId}:${c.version}`;
		if (seenChange.has(key)) return false;
		seenChange.add(key);
		return true;
	});

	// Dedupe runs by executionId, then derive real 24h headline counts before
	// slicing the display window.
	const seenRun = new Set<string>();
	const runs = runsRaw.filter((r) => {
		if (seenRun.has(r.executionId)) return false;
		seenRun.add(r.executionId);
		return true;
	});

	let runs24h = 0;
	let failed24h = 0;
	for (const r of runs) {
		const startedMs = Date.parse(r.startedAt);
		if (Number.isFinite(startedMs) && startedMs >= dayAgo) {
			runs24h += 1;
			if (r.status === "error") failed24h += 1;
		}
	}

	const stats: Stats = dashboard?.stats ?? EMPTY_STATS;

	return {
		// Whether the underlying dashboard read model was reachable, so the
		// page can distinguish "empty workspace" from "counts unavailable".
		dashboardOk: dashboard !== null,
		stats,
		runsHeadline: { runs24h, failed24h },
		activeSessions,
		recentChanges,
		recentRuns: runs.slice(0, 6),
	};
};

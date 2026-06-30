import type { PageServerLoad } from "./$types";
import type { RunSummary } from "$lib/server/workflows/runs";
import type { DevEnvironmentSummary } from "$lib/server/workflows/dev-environments";
import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";
import type {
	CapacityObserverResult,
	CapacityBusinessWorkSummary,
} from "$lib/types/capacity";

/**
 * /dashboard — the platform COMMAND CENTER.
 *
 * Loads, in parallel, a live snapshot of the five resource domains a platform
 * engineer needs at a glance. Every source is fetched against an EXISTING
 * internal endpoint (never fabricated) and wrapped so a slow, empty, or
 * permission-gated source degrades to an empty state instead of failing the
 * whole page:
 *
 *   SESSIONS             → GET /api/v1/dashboard            (counts + active list)
 *   WORKFLOWS            → GET /api/v1/runs                 (recent executions)
 *   FLEET                → GET /api/v1/agent-runtimes       (runtime warm-pools)
 *                          GET /api/capacity/overview       (queue/capacity health)
 *   PREVIEW ENVIRONMENTS → GET /api/dev-environments        (active dev previews)
 *   GITOPS PIPELINE      → GET /api/v1/gitops/events        (admin-gated activity)
 */

type DashboardPayload = {
	stats: {
		activeSessions: number;
		sessionsToday: number;
		archivedLast24h: number;
		tokensOut7d: number;
		tokensIn7d: number;
		totalAgents: number;
		totalEnvironments: number;
		totalVaults: number;
	};
	activeSessions: Array<{
		id: string;
		title: string | null;
		status: string;
		agentId: string;
		agentName: string;
		agentAvatar: string | null;
		updatedAt: string;
		createdAt: string;
	}>;
	recentChanges: Array<{
		kind: "agent" | "environment";
		resourceId: string;
		resourceName: string;
		version: number;
		publishedAt: string | null;
	}>;
};

type RuntimeRow = {
	name: string;
	slug: string | null;
	appId: string;
	phase: "Active" | "Sleeping" | "Starting" | "Unknown" | string;
	desiredReplicas: number;
	replicas: number;
	readyReplicas: number;
	browserSidecarEnabled: boolean;
};

const SOURCE_TIMEOUT_MS = 8_000;

/** Fetch + parse JSON from an internal endpoint, bounded by a timeout. Any
 *  failure (network, non-2xx, abort, bad JSON) resolves to `null` so a single
 *  unhealthy source can never take down the command center. */
async function fetchJson<T>(
	fetch: typeof globalThis.fetch,
	url: string,
): Promise<{ ok: boolean; status: number; data: T | null }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
	try {
		const res = await fetch(url, { signal: controller.signal });
		if (!res.ok) return { ok: false, status: res.status, data: null };
		const data = (await res.json()) as T;
		return { ok: true, status: res.status, data };
	} catch {
		return { ok: false, status: 0, data: null };
	} finally {
		clearTimeout(timer);
	}
}

export const load: PageServerLoad = async ({ fetch, parent }) => {
	const { user, platformRole } = await parent();
	const isAdmin = platformRole === "ADMIN";

	const [
		dashboard,
		runsRes,
		runtimesRes,
		capacityRes,
		previewsRes,
		gitopsRes,
	] = await Promise.all([
		fetchJson<DashboardPayload>(fetch, "/api/v1/dashboard"),
		fetchJson<{ runs: RunSummary[] }>(fetch, "/api/v1/runs?limit=8"),
		fetchJson<{ runtimes: RuntimeRow[] }>(fetch, "/api/v1/agent-runtimes"),
		fetchJson<{
			observer: CapacityObserverResult;
			businessWork: CapacityBusinessWorkSummary | null;
		}>(fetch, "/api/capacity/overview"),
		fetchJson<{ environments: DevEnvironmentSummary[] }>(
			fetch,
			"/api/dev-environments",
		),
		// Admin-only. Skip the call entirely for non-admins so we surface a clear
		// "restricted" empty state rather than a noisy 403.
		isAdmin
			? fetchJson<{ generatedAt: string; events: GitOpsActivityEvent[] }>(
					fetch,
					"/api/v1/gitops/events?limit=14",
				)
			: Promise.resolve({ ok: false, status: 403, data: null }),
	]);

	// ---- SESSIONS -----------------------------------------------------------
	const sessionsData = dashboard.data;
	const activeSessions = sessionsData?.activeSessions ?? [];
	const sessions = {
		ok: dashboard.ok,
		stats: sessionsData?.stats ?? null,
		active: activeSessions,
		counts: {
			running: activeSessions.filter((s) => s.status === "running").length,
			idle: activeSessions.filter((s) => s.status === "idle").length,
		},
		recentChanges: sessionsData?.recentChanges ?? [],
	};

	// ---- WORKFLOWS ----------------------------------------------------------
	const runs = runsRes.data?.runs ?? [];
	const wfCounts = runs.reduce(
		(acc, r) => {
			acc[r.status] = (acc[r.status] ?? 0) + 1;
			return acc;
		},
		{} as Record<string, number>,
	);
	const workflows = {
		ok: runsRes.ok,
		runs,
		counts: wfCounts,
		running: (wfCounts.running ?? 0) + (wfCounts.pending ?? 0),
	};

	// ---- FLEET --------------------------------------------------------------
	const runtimes = runtimesRes.data?.runtimes ?? [];
	const observer = capacityRes.data?.observer ?? null;
	const snapshot = observer && observer.available ? observer.snapshot : null;
	const business = capacityRes.data?.businessWork ?? null;
	const fleet = {
		ok: runtimesRes.ok || capacityRes.ok,
		runtimes,
		phaseCounts: runtimes.reduce(
			(acc, r) => {
				acc[r.phase] = (acc[r.phase] ?? 0) + 1;
				return acc;
			},
			{} as Record<string, number>,
		),
		readyReplicas: runtimes.reduce((n, r) => n + (r.readyReplicas ?? 0), 0),
		desiredReplicas: runtimes.reduce((n, r) => n + (r.desiredReplicas ?? 0), 0),
		capacity: snapshot
			? {
					cluster: snapshot.cluster,
					sampledAt: snapshot.sampledAt,
					queues: snapshot.queues.map((q) => ({
						name: q.name,
						active: q.active ?? true,
						admitted: q.admittedWorkloads,
						pending: q.pendingWorkloads,
						reserving: q.reservingWorkloads,
					})),
					blockedWorkloads: snapshot.blockedWorkloads.length,
					recentPreemptions: snapshot.recentPreemptions,
					activeWork: business?.totals.activeWork ?? null,
				}
			: null,
		capacityError:
			observer && !observer.available ? observer.error : null,
	};

	// ---- PREVIEW ENVIRONMENTS ----------------------------------------------
	const environments = previewsRes.data?.environments ?? [];
	const previews = {
		ok: previewsRes.ok,
		environments,
		ready: environments.filter((e) => e.ready).length,
		building: environments.filter((e) => !e.ready).length,
	};

	// ---- GITOPS PIPELINE ----------------------------------------------------
	const events = gitopsRes.data?.events ?? [];
	const gitops = {
		ok: gitopsRes.ok,
		restricted: !isAdmin,
		events,
		generatedAt: gitopsRes.data?.generatedAt ?? null,
	};

	return {
		user,
		isAdmin,
		generatedAt: new Date().toISOString(),
		sessions,
		workflows,
		fleet,
		previews,
		gitops,
	};
};

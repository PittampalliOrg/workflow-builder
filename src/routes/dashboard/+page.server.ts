import type { PageServerLoad } from "./$types";
import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { getAggregateMetrics } from "$lib/server/metrics/aggregate";
import { listSessions } from "$lib/server/sessions/registry";
import { listRecentRuns } from "$lib/server/workflows/runs";
import { listDevEnvironments } from "$lib/server/workflows/dev-environments";
import { isPlatformAdmin } from "$lib/server/platform-admin";

/**
 * Dashboard — unified monitoring command center.
 *
 * Everything below is server-rendered from the platform's REAL data sources so
 * the page paints a coherent operational story with no client-only fetch flash:
 *
 *   - getAggregateMetrics()  → the platform heartbeat: live session/run counts,
 *     token throughput (ratePerSec drives the signature pulse ribbon), 5-minute
 *     failure window, and per-pod CPU/memory pressure. This is the same source
 *     the admin metrics page polls; we read the lib directly (not the admin-
 *     gated HTTP route) because the command center IS the operator's heartbeat.
 *   - listSessions / listRecentRuns / listDevEnvironments → the workspace-scoped
 *     activity feed and live-preview tiles.
 *   - /api/v1/agent-runtimes → fleet readiness (ready vs desired replicas).
 *   - /api/v1/cost          → 7-day token volume + spend.
 *   - /api/v1/gitops/events → delivery activity (ADMIN ONLY; silently absent
 *     for members, exactly as the gitops route itself gates).
 *
 * Every source is wrapped so one failure degrades to an honest empty/unavailable
 * state instead of taking the page down. No value here is fabricated.
 */

type ActivityKind = "run" | "session" | "deploy";
type Outcome = "running" | "success" | "error" | "pending" | "info";

type ActivityRow = {
	id: string;
	kind: ActivityKind;
	name: string;
	sub: string | null;
	outcome: Outcome;
	statusLabel: string;
	ts: string;
	href: string;
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Map a heterogeneous status/phase string onto one of our outcome buckets. */
function toOutcome(raw: string | null | undefined): Outcome {
	const s = (raw ?? "").toLowerCase();
	if (["running", "progressing", "syncing", "rescheduling", "in_progress"].some((k) => s.includes(k)))
		return "running";
	if (["pending", "queued", "starting", "idle", "paused"].some((k) => s.includes(k)))
		return "pending";
	if (["success", "succeeded", "healthy", "synced", "ready", "completed", "terminated"].some((k) => s.includes(k)))
		return "success";
	if (["error", "fail", "degraded", "outofsync", "cancel", "killed", "crash"].some((k) => s.includes(k)))
		return "error";
	return "info";
}

export const load: PageServerLoad = async ({ locals, fetch, depends }) => {
	// Live console: register a refresh key so the client can re-run JUST this
	// load on an interval (invalidate('cc:dashboard')) — keeping counts, the
	// activity feed, health verdict and throughput current without re-running
	// the whole layout tree or introducing a separate polling endpoint.
	depends("cc:dashboard");

	const session = locals.session;

	if (!session?.userId) {
		// The root layout already redirects unauthenticated callers to sign-in;
		// this is just a defensive empty payload that keeps PageData a single
		// shape (so the component never has to narrow a union).
		return emptyPayload();
	}

	const userId = session.userId;
	const projectId = session.projectId;
	const slug = "default"; // magic slug — hooks.server.ts resolves to active workspace

	const safe = async <T, F>(p: Promise<T>, fallback: F): Promise<T | F> => {
		try {
			return await p;
		} catch {
			return fallback;
		}
	};

	const weekAgo = new Date(Date.now() - WEEK_MS);

	const [userRow] = db
		? await safe(
				db
					.select({ name: users.name, email: users.email })
					.from(users)
					.where(eq(users.id, userId))
					.limit(1),
				[] as { name: string | null; email: string | null }[],
			)
		: [];

	const isAdmin = await safe(isPlatformAdmin(userId), false);

	// Fetch every source in parallel; each degrades independently.
	const [metrics, sessions, runs, previews, fleetRes, costRes, gitopsRes] =
		await Promise.all([
			safe(getAggregateMetrics(), null),
			projectId
				? safe(listSessions({ projectId, limit: 12 }), [])
				: Promise.resolve([]),
			projectId
				? safe(listRecentRuns({ projectId, limit: 12 }), [])
				: Promise.resolve([]),
			safe(listDevEnvironments(projectId), []),
			safe(
				fetch("/api/v1/agent-runtimes").then((r) => (r.ok ? r.json() : null)),
				null,
			),
			safe(
				fetch(`/api/v1/cost?start=${weekAgo.toISOString()}`).then((r) =>
					r.ok ? r.json() : null,
				),
				null,
			),
			isAdmin
				? safe(
						fetch("/api/v1/gitops/events?limit=40").then((r) =>
							r.ok ? r.json() : null,
						),
						null,
					)
				: Promise.resolve(null),
		]);

	// ---- Fleet readiness ------------------------------------------------------
	type Runtime = {
		readyReplicas?: number;
		desiredReplicas?: number;
		phase?: string;
	};
	const runtimes: Runtime[] = Array.isArray(fleetRes?.runtimes)
		? fleetRes.runtimes
		: [];
	const fleet =
		runtimes.length > 0
			? {
					pools: runtimes.length,
					ready: runtimes.reduce((a, r) => a + (r.readyReplicas ?? 0), 0),
					desired: runtimes.reduce((a, r) => a + (r.desiredReplicas ?? 0), 0),
					active: runtimes.filter((r) => r.phase === "Active").length,
				}
			: null;

	// ---- 7-day token volume + spend ------------------------------------------
	type ModelRow = { inputTokens?: number; outputTokens?: number };
	const byModel: ModelRow[] = Array.isArray(costRes?.byModel)
		? costRes.byModel
		: [];
	const tokens7d = byModel.reduce(
		(a, m) => a + (m.inputTokens ?? 0) + (m.outputTokens ?? 0),
		0,
	);
	const cost7d = typeof costRes?.totalCost === "number" ? costRes.totalCost : null;

	// ---- GitOps delivery (admin only) ----------------------------------------
	type GitOpsEvent = {
		eventId: string;
		phase: string | null;
		activityType: string;
		observedAt: string;
		resourceRef: { name: string | null; kind: string | null };
		reason: string | null;
	};
	const gitopsEvents: GitOpsEvent[] = Array.isArray(gitopsRes?.events)
		? gitopsRes.events
		: [];
	const rollingDeploys = (() => {
		// Count the most-recent phase per resource; a resource is "rolling" while
		// its latest event is Progressing/Running/Syncing.
		const latest = new Map<string, GitOpsEvent>();
		for (const e of gitopsEvents) {
			const key = `${e.resourceRef.kind}/${e.resourceRef.name}`;
			const prev = latest.get(key);
			if (!prev || e.observedAt > prev.observedAt) latest.set(key, e);
		}
		let n = 0;
		for (const e of latest.values()) if (toOutcome(e.phase) === "running") n++;
		return n;
	})();

	// ---- Live-now counts ------------------------------------------------------
	const liveSessions = metrics?.sessions.running ?? 0;
	const liveRuns =
		(metrics?.workflows.running ?? 0) + (metrics?.workflows.pending ?? 0);
	const livePreviews = previews.filter((p) => p.ready).length;
	const livePreviewsTotal = previews.length;

	// ---- Capacity / resource pressure ----------------------------------------
	const resources = metrics?.resources ?? null;
	const resourceClasses = resources
		? Object.entries(resources.byClass)
				.map(([name, v]) => ({
					name,
					count: v.count,
					cpuMillicores: v.cpuMillicores,
					memoryMiB: v.memoryMiB,
				}))
				.filter((c) => c.count > 0 || c.cpuMillicores > 0 || c.memoryMiB > 0)
				.sort((a, b) => b.cpuMillicores - a.cpuMillicores)
		: [];

	// ---- Synthesized health verdict ------------------------------------------
	const failures5 = metrics?.workflows.failuresLast5Min ?? 0;
	const wfErrors = metrics?.workflows.error ?? 0;
	const fleetGap = fleet ? Math.max(0, fleet.desired - fleet.ready) : 0;
	const fleetTotallyDown = !!fleet && fleet.desired > 0 && fleet.ready === 0;

	let healthState: "healthy" | "degraded" | "critical" | "unknown";
	let healthReason: string;
	if (!metrics) {
		healthState = "unknown";
		healthReason = "Platform metrics are unavailable — showing workspace data only.";
	} else if (failures5 >= 3 || fleetTotallyDown) {
		healthState = "critical";
		healthReason = fleetTotallyDown
			? `Fleet is offline — 0 of ${fleet?.desired} runtime replicas ready.`
			: `${failures5} workflow runs failed in the last 5 minutes.`;
	} else if (failures5 >= 1 || fleetGap > 0 || wfErrors > 0) {
		healthState = "degraded";
		const bits: string[] = [];
		if (failures5 >= 1)
			bits.push(`${failures5} recent failure${failures5 === 1 ? "" : "s"}`);
		if (fleetGap > 0)
			bits.push(`${fleetGap} fleet replica${fleetGap === 1 ? "" : "s"} catching up`);
		if (wfErrors > 0 && failures5 === 0)
			bits.push(`${wfErrors} errored run${wfErrors === 1 ? "" : "s"} this hour`);
		healthReason = `${bits.join(" · ")}.`;
	} else {
		healthState = "healthy";
		const rate = Math.round(metrics.tokens.ratePerSec);
		healthReason =
			liveRuns + liveSessions > 0
				? `All systems nominal — ${liveSessions} session${liveSessions === 1 ? "" : "s"} and ${liveRuns} run${liveRuns === 1 ? "" : "s"} live at ${formatRate(rate)}.`
				: "All systems nominal — platform idle and ready.";
	}

	// ---- Unified activity feed -----------------------------------------------
	const activity: ActivityRow[] = [];

	for (const r of runs) {
		activity.push({
			id: `run:${r.executionId}`,
			kind: "run",
			name: r.workflowName,
			sub:
				r.agents.length > 0
					? r.agents.map((a) => a.name).slice(0, 2).join(", ")
					: r.sessionCount > 0
						? `${r.sessionCount} session${r.sessionCount === 1 ? "" : "s"}`
						: null,
			outcome: toOutcome(r.status),
			statusLabel: r.status,
			ts: r.startedAt,
			href: `/workspaces/${slug}/workflows/${r.workflowId}/runs/${r.executionId}`,
		});
	}

	for (const s of sessions) {
		activity.push({
			id: `session:${s.id}`,
			kind: "session",
			name: s.title ?? s.agentName ?? "Untitled session",
			sub: s.agentName ?? null,
			outcome: toOutcome(s.status),
			statusLabel: s.status,
			ts: s.updatedAt,
			href: `/workspaces/${slug}/sessions/${s.id}`,
		});
	}

	if (isAdmin) {
		// Latest event per resource only — keep the feed about delivery outcomes,
		// not every reconcile tick.
		const latest = new Map<string, GitOpsEvent>();
		for (const e of gitopsEvents) {
			const key = `${e.resourceRef.kind}/${e.resourceRef.name}`;
			const prev = latest.get(key);
			if (!prev || e.observedAt > prev.observedAt) latest.set(key, e);
		}
		for (const e of [...latest.values()].slice(0, 8)) {
			activity.push({
				id: `deploy:${e.eventId}`,
				kind: "deploy",
				name: e.resourceRef.name ?? e.activityType,
				sub: e.resourceRef.kind ?? e.reason ?? null,
				outcome: toOutcome(e.phase),
				statusLabel: e.phase ?? "event",
				ts: e.observedAt,
				href: "/admin/gitops",
			});
		}
	}

	activity.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

	return {
		authed: true,
		generatedAt: new Date().toISOString(),
		slug,
		isAdmin,
		user: userRow
			? { name: userRow.name ?? null, email: userRow.email ?? null }
			: null,
		health: {
			state: healthState,
			reason: healthReason,
			signals: {
				failuresLast5Min: failures5,
				errorsThisHour: wfErrors,
				fleetGap,
			},
		},
		pulse: {
			ratePerSec: metrics?.tokens.ratePerSec ?? 0,
			tokensLastHour: metrics?.tokens.lastHour.total ?? 0,
			toolCallsLastHour: metrics?.toolCallsLastHour ?? 0,
		},
		liveNow: {
			sessions: liveSessions,
			runs: liveRuns,
			previews: livePreviews,
			previewsTotal: livePreviewsTotal,
			deploys: rollingDeploys,
		},
		capacity: {
			fleet,
			tokens7d,
			cost7d,
			tokensLastHour: metrics?.tokens.lastHour.total ?? 0,
			ratePerSec: metrics?.tokens.ratePerSec ?? 0,
			resources: resources
				? {
						cpuMillicores: resources.totalCpuMillicores,
						memoryMiB: resources.totalMemoryMiB,
						podCount: resources.pods.length,
						byClass: resourceClasses,
					}
				: null,
		},
		previews: previews.slice(0, 6).map((p) => ({
			executionId: p.executionId,
			service: p.service,
			ready: p.ready,
			runStatus: p.runStatus,
			href: `/workspaces/${slug}/dev/${p.executionId}`,
			browseUrl: p.browseUrl,
		})),
		activity: activity.slice(0, 12),
		metricsAvailable: !!metrics,
	};
};

function formatRate(rate: number): string {
	if (rate >= 1000) return `${(rate / 1000).toFixed(1)}k tok/s`;
	return `${rate} tok/s`;
}

/** Defensive empty payload — same shape as the authed return, all zeros. */
function emptyPayload() {
	return {
		authed: false,
		generatedAt: new Date().toISOString(),
		slug: "default",
		isAdmin: false,
		user: null as { name: string | null; email: string | null } | null,
		health: {
			state: "unknown" as "healthy" | "degraded" | "critical" | "unknown",
			reason: "Sign in to view the command center.",
			signals: { failuresLast5Min: 0, errorsThisHour: 0, fleetGap: 0 },
		},
		pulse: { ratePerSec: 0, tokensLastHour: 0, toolCallsLastHour: 0 },
		liveNow: {
			sessions: 0,
			runs: 0,
			previews: 0,
			previewsTotal: 0,
			deploys: 0,
		},
		capacity: {
			fleet: null as {
				pools: number;
				ready: number;
				desired: number;
				active: number;
			} | null,
			tokens7d: 0,
			cost7d: null as number | null,
			tokensLastHour: 0,
			ratePerSec: 0,
			resources: null as {
				cpuMillicores: number;
				memoryMiB: number;
				podCount: number;
				byClass: {
					name: string;
					count: number;
					cpuMillicores: number;
					memoryMiB: number;
				}[];
			} | null,
		},
		previews: [] as {
			executionId: string;
			service: string;
			ready: boolean;
			runStatus: string | null;
			href: string;
			browseUrl: string | null;
		}[],
		activity: [] as ActivityRow[],
		metricsAvailable: false,
	};
}

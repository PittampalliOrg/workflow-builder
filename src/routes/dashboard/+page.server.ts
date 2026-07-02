import type { PageServerLoad } from "./$types";
import { DEFAULT_WORKSPACE_SLUG as SLUG } from "$lib/utils/workspace-path";

/**
 * Server-side aggregation for the Unified Monitoring Command Center.
 *
 * Every region is sourced from an EXISTING /api/v1 (or /api) endpoint via the
 * SvelteKit `fetch` (which forwards the caller's auth cookie). Each source is
 * wrapped so a 4xx/5xx/network error degrades to an explicit `unknown` signal
 * instead of breaking the page — "no signal" must never read as "healthy".
 *
 * No values are fabricated: if a source is empty we surface an empty state and
 * the health verdict visibly loses that contributing signal.
 */

type Fetched<T> = { ok: boolean; status: number; data: T | null };

async function pull<T = unknown>(
	fetch: typeof globalThis.fetch,
	url: string,
): Promise<Fetched<T>> {
	try {
		const res = await fetch(url);
		if (!res.ok) return { ok: false, status: res.status, data: null };
		return { ok: true, status: res.status, data: (await res.json()) as T };
	} catch {
		return { ok: false, status: 0, data: null };
	}
}

// ---- source response shapes (subset we consume) -------------------------

type SessionRow = {
	id: string;
	title: string | null;
	status: string;
	agentId: string;
	agentName: string | null;
	agentAvatar: string | null;
	errorMessage: string | null;
	workflowExecutionId: string | null;
	createdAt: string;
	updatedAt: string;
};
type RunRow = {
	executionId: string;
	workflowId: string;
	workflowName: string;
	status: "pending" | "running" | "success" | "error" | "cancelled";
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
	sessionCount: number;
	agents?: Array<{ name: string; avatar: string | null }>;
};
type RuntimeRow = {
	name: string;
	slug: string | null;
	appId: string;
	phase: "Active" | "Starting" | "Sleeping" | "Unknown";
	desiredReplicas: number;
	replicas: number;
	readyReplicas: number;
};
type DevEnvRow = {
	executionId: string;
	service: string;
	browseUrl: string | null;
	ready: boolean;
	runStatus: string | null;
	sessionId: string | null;
	sessionUrl: string | null;
	createdAt: string;
};
type GitOpsEvent = {
	eventId: string;
	activityType: string;
	phase: string | null;
	reason: string | null;
	message: string | null;
	observedAt: string;
	resourceRef: { kind: string | null; name: string | null };
};

type Outcome = "ok" | "running" | "error" | "warn" | "synced" | "neutral";
type Health = "operational" | "degraded" | "critical" | "unknown";

export type FeedItem = {
	id: string;
	kind: "run" | "session" | "deploy" | "publish";
	title: string;
	subtitle: string | null;
	outcome: Outcome;
	statusLabel: string;
	at: string;
	href: string | null;
};

export type HealthSignal = {
	key: string;
	label: string;
	state: Health;
	detail: string;
};

const ws = (suffix: string) => `/workspaces/${SLUG}/${suffix.replace(/^\//, "")}`;

function runOutcome(s: RunRow["status"]): { o: Outcome; label: string } {
	switch (s) {
		case "success":
			return { o: "ok", label: "completed" };
		case "error":
			return { o: "error", label: "failed" };
		case "running":
		case "pending":
			return { o: "running", label: s === "pending" ? "queued" : "running" };
		case "cancelled":
			return { o: "warn", label: "cancelled" };
	}
}

function gitOutcome(phase: string | null): { o: Outcome; label: string } {
	const p = (phase ?? "").toLowerCase();
	if (/(synced|succeed|healthy|complete)/.test(p))
		return { o: "synced", label: phase ?? "synced" };
	if (/(fail|error|degrad)/.test(p))
		return { o: "error", label: phase ?? "failed" };
	if (/(progress|running|sync)/.test(p))
		return { o: "running", label: phase ?? "progressing" };
	return { o: "neutral", label: phase ?? "event" };
}

const worst = (a: Health, b: Health): Health => {
	const rank: Record<Health, number> = {
		critical: 3,
		degraded: 2,
		operational: 1,
		unknown: 0,
	};
	return rank[a] >= rank[b] ? a : b;
};

export const load: PageServerLoad = async ({ fetch, parent }) => {
	try {
	const parentData = await parent().catch(() => ({}) as Record<string, unknown>);
	const user =
		(parentData as { user?: { name: string | null; email: string | null } })
			.user ?? null;

	const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();

	const [
		sessionsR,
		runsR,
		runtimesR,
		usageR,
		costR,
		liveR,
		devR,
		gitopsR,
		dashR,
	] = await Promise.all([
		pull<{ sessions: SessionRow[] }>(fetch, "/api/v1/sessions?limit=100"),
		pull<{ runs: RunRow[] }>(fetch, "/api/v1/runs?limit=40"),
		pull<{ runtimes: RuntimeRow[] }>(fetch, "/api/v1/agent-runtimes"),
		pull<{
			totals: { tokensIn: number; tokensOut: number; sessionCount: number };
			daily: Array<{ day: string; tokensIn: number; tokensOut: number }>;
		}>(fetch, `/api/v1/usage?start=${weekAgo}`),
		pull<{
			totalCost: number;
			byModel: Array<{ model: string; cost: number; sessions: number }>;
		}>(fetch, "/api/v1/cost"),
		pull<{
			activeSessions: number;
			byModel: Array<{
				model: string;
				tokensOutLastMinute: number;
				tokensOutLastHour: number;
			}>;
		}>(fetch, "/api/v1/limits/live"),
		pull<{ environments: DevEnvRow[] }>(fetch, "/api/dev-environments"),
		pull<{ events: GitOpsEvent[] }>(fetch, "/api/v1/gitops/events?limit=30"),
		pull<{
			stats: { totalAgents: number; totalEnvironments: number };
			recentChanges: Array<{
				kind: "agent" | "environment";
				resourceId: string;
				resourceName: string;
				version: number;
				publishedAt: string | null;
			}>;
		}>(fetch, "/api/v1/dashboard"),
	]);

	const sessions = sessionsR.data?.sessions ?? [];
	const runs = runsR.data?.runs ?? [];
	const runtimes = runtimesR.data?.runtimes ?? [];
	const devEnvs = devR.data?.environments ?? [];
	const gitEvents = gitopsR.data?.events ?? [];

	// ---- RUNNING NOW --------------------------------------------------------
	const runningSessions = sessions.filter((s) => s.status === "running");
	const idleSessions = sessions.filter((s) => s.status === "idle");
	const inFlightRuns = runs.filter(
		(r) => r.status === "running" || r.status === "pending",
	);
	const livePreviews = devEnvs.filter(
		(e) => e.ready || e.runStatus === "running",
	);
	const inProgressDeploys = gitEvents.filter((e) =>
		/(progress|running|sync(?!ed))/i.test(e.phase ?? ""),
	);

	const runningNow = {
		sessions: runningSessions.slice(0, 6).map((s) => ({
			id: s.id,
			title: s.title ?? "Untitled session",
			agentName: s.agentName ?? "agent",
			agentAvatar: s.agentAvatar,
			hasError: !!s.errorMessage,
			errorMessage: s.errorMessage,
			at: s.updatedAt,
			href: ws(`sessions/${s.id}`),
		})),
		runs: inFlightRuns.slice(0, 6).map((r) => ({
			id: r.executionId,
			name: r.workflowName,
			startedAt: r.startedAt,
			sessionCount: r.sessionCount,
			href: ws(`workflows/${r.workflowId}/runs/${r.executionId}`),
		})),
		previews: livePreviews.slice(0, 6).map((e) => ({
			id: e.executionId,
			service: e.service,
			ready: e.ready,
			href: e.sessionUrl ?? e.browseUrl,
			browseUrl: e.browseUrl,
			at: e.createdAt,
		})),
		counts: {
			sessions: runningSessions.length,
			idle: idleSessions.length,
			runs: inFlightRuns.length,
			previews: livePreviews.length,
			deploys: inProgressDeploys.length,
		},
	};

	// ---- RECENT ACTIVITY (one merged, newest-first timeline) -----------------
	const feed: FeedItem[] = [];
	for (const r of runs) {
		const { o, label } = runOutcome(r.status);
		feed.push({
			id: `run:${r.executionId}`,
			kind: "run",
			title: r.workflowName,
			subtitle:
				r.sessionCount > 0
					? `${r.sessionCount} session${r.sessionCount === 1 ? "" : "s"}`
					: null,
			outcome: o,
			statusLabel: label,
			at: r.completedAt ?? r.startedAt,
			href: ws(`workflows/${r.workflowId}/runs/${r.executionId}`),
		});
	}
	for (const s of sessions.slice(0, 30)) {
		const isErr = !!s.errorMessage;
		feed.push({
			id: `session:${s.id}`,
			kind: "session",
			title: s.title ?? "Untitled session",
			subtitle: s.agentName ?? null,
			outcome: isErr ? "error" : s.status === "running" ? "running" : "neutral",
			statusLabel: isErr ? "errored" : s.status,
			at: s.updatedAt,
			href: ws(`sessions/${s.id}`),
		});
	}
	for (const e of gitEvents) {
		const { o, label } = gitOutcome(e.phase ?? e.reason);
		feed.push({
			id: `deploy:${e.eventId}`,
			kind: "deploy",
			title: e.resourceRef.name ?? e.activityType ?? "deploy",
			subtitle: e.message ?? e.reason ?? e.resourceRef.kind,
			outcome: o,
			statusLabel: label,
			at: e.observedAt,
			href: null,
		});
	}
	for (const c of dashR.data?.recentChanges ?? []) {
		if (!c.publishedAt) continue;
		feed.push({
			id: `publish:${c.kind}:${c.resourceId}:${c.version}`,
			kind: "publish",
			title: c.resourceName,
			subtitle: `${c.kind} · v${c.version}`,
			outcome: "neutral",
			statusLabel: "published",
			at: c.publishedAt,
			href:
				c.kind === "agent"
					? ws(`agents/${c.resourceId}`)
					: ws(`environments/${c.resourceId}`),
		});
	}
	feed.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
	const activity = feed.slice(0, 24);

	// ---- CAPACITY & USAGE ---------------------------------------------------
	const daily = usageR.data?.daily ?? [];
	const tokenTrend = daily.map((d) => d.tokensOut);
	const tokensOut7d = usageR.data?.totals.tokensOut ?? 0;
	const tokensIn7d = usageR.data?.totals.tokensIn ?? 0;
	const tokensToday = daily.length ? daily[daily.length - 1].tokensOut : 0;
	const tokensOutPerMin =
		liveR.data?.byModel.reduce((a, m) => a + m.tokensOutLastMinute, 0) ?? 0;

	const activePools = runtimes.filter((r) => r.phase !== "Sleeping");
	const desired = runtimes.reduce((a, r) => a + r.desiredReplicas, 0);
	const ready = runtimes.reduce((a, r) => a + r.readyReplicas, 0);
	const fleetUtil = desired > 0 ? Math.round((ready / desired) * 100) : null;
	const phaseMix = {
		active: runtimes.filter((r) => r.phase === "Active").length,
		starting: runtimes.filter((r) => r.phase === "Starting").length,
		sleeping: runtimes.filter((r) => r.phase === "Sleeping").length,
		unknown: runtimes.filter((r) => r.phase === "Unknown").length,
	};

	const capacity = {
		tokensOut7d,
		tokensIn7d,
		tokensToday,
		tokenTrend,
		tokensOutPerMin,
		hasUsage: usageR.ok && tokensOut7d + tokensIn7d > 0,
		totalCost: costR.data?.totalCost ?? 0,
		hasCost: costR.ok,
		topModels: (costR.data?.byModel ?? []).slice(0, 3),
		fleet: {
			util: fleetUtil,
			ready,
			desired,
			poolCount: runtimes.length,
			activePools: activePools.length,
			phaseMix,
			pools: runtimes
				.slice()
				.sort((a, b) => b.desiredReplicas - a.desiredReplicas)
				.slice(0, 6)
				.map((r) => ({
					name: r.slug ?? r.name,
					phase: r.phase,
					ready: r.readyReplicas,
					desired: r.desiredReplicas,
				})),
			available: runtimesR.ok,
		},
		liveRate: liveR.ok,
	};

	// ---- SYSTEM HEALTH (synthesized) ---------------------------------------
	const signals: HealthSignal[] = [];

	// Fleet readiness
	if (!runtimesR.ok) {
		signals.push({
			key: "runtimes",
			label: "Fleet",
			state: "unknown",
			detail: "runtime signal unavailable",
		});
	} else if (runtimes.length === 0) {
		signals.push({
			key: "runtimes",
			label: "Fleet",
			state: "unknown",
			detail: "no warm pools registered",
		});
	} else {
		const starting = phaseMix.starting + phaseMix.unknown;
		const underReady = runtimes.some(
			(r) => r.desiredReplicas > 0 && r.readyReplicas < r.desiredReplicas,
		);
		signals.push({
			key: "runtimes",
			label: "Fleet",
			state: starting > 0 || underReady ? "degraded" : "operational",
			detail:
				starting > 0
					? `${starting} pool${starting === 1 ? "" : "s"} starting`
					: `${ready}/${desired} replicas ready`,
		});
	}

	// Session error states
	const erroredRunning = sessions.filter(
		(s) => s.errorMessage && s.status !== "terminated",
	);
	if (!sessionsR.ok) {
		signals.push({
			key: "sessions",
			label: "Sessions",
			state: "unknown",
			detail: "session signal unavailable",
		});
	} else {
		const n = erroredRunning.length;
		signals.push({
			key: "sessions",
			label: "Sessions",
			state: n === 0 ? "operational" : n >= 3 ? "critical" : "degraded",
			detail:
				n === 0
					? `${runningSessions.length} running · 0 errors`
					: `${n} session${n === 1 ? "" : "s"} reporting errors`,
		});
	}

	// GitOps sync (admin-gated source — absence is unknown, not unhealthy)
	if (!gitopsR.ok) {
		signals.push({
			key: "gitops",
			label: "Delivery",
			state: "unknown",
			detail:
				gitopsR.status === 403
					? "requires platform admin"
					: "delivery signal unavailable",
		});
	} else if (gitEvents.length === 0) {
		signals.push({
			key: "gitops",
			label: "Delivery",
			state: "unknown",
			detail: "no recent delivery events",
		});
	} else {
		const failed = gitEvents.filter((e) =>
			/(fail|error|degrad)/i.test(e.phase ?? ""),
		).length;
		signals.push({
			key: "gitops",
			label: "Delivery",
			state: failed > 0 ? "degraded" : "operational",
			detail:
				failed > 0
					? `${failed} delivery issue${failed === 1 ? "" : "s"}`
					: "all deploys synced",
		});
	}

	const contributing = signals
		.map((s) => s.state)
		.filter((s) => s !== "unknown") as Health[];
	const overall: Health = contributing.length
		? contributing.reduce(worst, "operational")
		: "unknown";

	const health = {
		overall,
		signals,
		errorCount: erroredRunning.length,
	};

	// ---- SIGNATURE RIBBON inputs (real throughput drives the waveform) ------
	const ribbon = {
		throughput: runningSessions.length + inFlightRuns.length,
		tokensOutPerMin,
		// 7-day token-out series → static sparkline under prefers-reduced-motion
		spark: tokenTrend,
	};

	return {
		user,
		slug: SLUG,
		generatedAt: new Date().toISOString(),
		availability: {
			sessions: sessionsR.ok,
			runs: runsR.ok,
			runtimes: runtimesR.ok,
			usage: usageR.ok,
			cost: costR.ok,
			live: liveR.ok,
			devEnvs: devR.ok,
			gitops: gitopsR.ok,
		},
		runningNow,
		activity,
		capacity,
		health,
		ribbon,
	};
	} catch (err) {
		console.error("[dashboard] load failed, serving empty command center", err);
		return {
			user: null,
			slug: SLUG,
			generatedAt: new Date().toISOString(),
			availability: { sessions: false, runs: false, runtimes: false, usage: false, cost: false, live: false, devEnvs: false, gitops: false },
			runningNow: { sessions: [], runs: [], previews: [], counts: { sessions: 0, idle: 0, runs: 0, previews: 0, deploys: 0 } },
			activity: [] as FeedItem[],
			capacity: { tokensOut7d: 0, tokensIn7d: 0, tokensToday: 0, tokenTrend: [] as number[], tokensOutPerMin: 0, hasUsage: false, totalCost: 0, hasCost: false, topModels: [] as Array<{ model: string; cost: number; sessions: number }>, fleet: { util: null as number | null, ready: 0, desired: 0, poolCount: 0, activePools: 0, phaseMix: { active: 0, starting: 0, sleeping: 0, unknown: 0 }, pools: [] as Array<{ name: string; phase: string; ready: number; desired: number }>, available: false }, liveRate: false },
			health: { overall: "unknown" as Health, signals: [] as HealthSignal[], errorCount: 0 },
			ribbon: { throughput: 0, tokensOutPerMin: 0, spark: [] as number[] },
		};
	}
};

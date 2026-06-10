/**
 * Pure GitOps notification detection — snapshot-diff transition predicates,
 * extracted from the deployment-notifications store so they're node-testable
 * (matching the service-matrix.ts / gates.ts factoring; rune classes carry no
 * unit tests in this repo).
 *
 * Source of truth is the INVENTORY DIFF for every state-transition kind
 * (flap-immune, ~1min latency at the inventory cadence); events are only
 * low-latency recheck triggers + the stream-liveness signal (store-side).
 * Baseline rule, applied uniformly: the first sight of a key (or the first
 * snapshot of a session) populates state and never notifies.
 */
import { isFailedValue } from "./activity-tone";
import { isPromotionPassing } from "./gates";

export type NotificationKind =
	| "deploy"
	| "build_failed"
	| "degraded"
	| "promotion_stuck"
	| "stream_health";

export type NotificationSeverity = "info" | "warning" | "error";

export type GitOpsNotification = {
	/** Stable dedupe id (per-kind scheme — see each predicate). */
	id: string;
	kind: NotificationKind;
	severity: NotificationSeverity;
	/** Empty for stream_health. */
	component: string;
	env: string;
	/** Pre-rendered headline, e.g. "build failed". */
	title: string;
	detail: string | null;
	/** deploy only (v1-compatible rendering). */
	fromTag: string | null;
	toTag: string | null;
	/** Epoch ms, stamped on detection. */
	at: number;
	read: boolean;
};

/** The slice of an inventory application the detector reads. */
export type InventoryApp = {
	component?: string;
	desired?: { image?: string | null } | null;
	live?: {
		images?: string[] | null;
		syncStatus?: string | null;
		healthStatus?: string | null;
	} | null;
	build?: {
		pipelineRun?: string | null;
		status?: string | null;
		reason?: string | null;
		finishedAt?: string | null;
	} | null;
	promotion?: {
		drySha?: string | null;
		hydratedSha?: string | null;
		healthPhase?: string | null;
	} | null;
};

export type InventoryEnv = { name?: string; applications?: InventoryApp[] };

export type ComponentState = {
	liveTags: Set<string>;
	build: { pipelineRun: string | null; status: string | null; reason: string | null } | null;
	/** Consecutive snapshots with healthStatus === "Degraded". */
	degradedStreak: number;
	/** Set once the current Degraded episode notified; reset on recovery. */
	degradedNotified: boolean;
	promotionPhase: string | null;
	/** Epoch ms the promotion first went non-passing; null when passing/absent. */
	promotionNonPassingSince: number | null;
	/** Last drySha (or phase) we alerted stuck/failed for — one alert per freight. */
	promotionNotifiedKey: string | null;
};

/** Key = `${env}:${component}`. */
export type DetectState = Map<string, ComponentState>;

/** Degraded must persist across this many consecutive snapshots (anti-flap). */
export const DEGRADED_CONFIRM_STREAK = 2;
/** Non-passing promotion age before alerting — clears the 10-min staging soak. */
export const PROMOTION_STUCK_MS = 15 * 60_000;

/** Strip the `:tag` (and any `@digest`) off an image ref to get the bare repo. */
export function repoOf(ref: string): string {
	return ref.split("@")[0].replace(/:[^:/]+$/, "");
}

/** The SET of tags of an app's OWN org image currently in `live.images`. During a
 *  rollout this can hold BOTH the old and new tag (old+new ReplicaSet pods both
 *  reported), which is exactly why detection diffs the SET rather than a single
 *  "current tag" — a genuinely new tag appearing is the rollout. `live.images`
 *  also carries sidecars (daprd, postgres, …), so we match only the component's
 *  own repo (derived from `desired.image`'s repo, or the canonical org path). */
export function liveTagsFor(app: InventoryApp): Set<string> {
	const images = app.live?.images ?? [];
	const repo = app.desired?.image
		? repoOf(app.desired.image)
		: app.component
			? `ghcr.io/pittampalliorg/${app.component}`
			: null;
	const tags = new Set<string>();
	if (repo) {
		const prefix = repo + ":";
		for (const img of images) {
			if (img.startsWith(prefix)) tags.add(img.slice(prefix.length).split("@")[0]);
		}
	}
	if (tags.size === 0 && app.component) {
		const needle = `/${app.component}:`;
		for (const img of images) {
			const i = img.lastIndexOf(needle);
			if (i >= 0) tags.add(img.slice(i + needle.length).split("@")[0]);
		}
	}
	return tags;
}

/** AttentionBanner-parity failed-build predicate (exact strings). */
export function isFailedBuild(
	build: InventoryApp["build"],
): build is NonNullable<InventoryApp["build"]> {
	if (!build) return false;
	return build.status === "False" || build.reason === "Failed" || build.reason === "Failure";
}

export function detect(
	prev: DetectState,
	envs: InventoryEnv[],
	now: number,
	isBaseline: boolean,
): { next: DetectState; fresh: GitOpsNotification[] } {
	const next: DetectState = new Map();
	const fresh: GitOpsNotification[] = [];

	for (const env of envs) {
		const envName = env.name ?? "";
		for (const app of env.applications ?? []) {
			if (!app.component) continue;
			const key = `${envName}:${app.component}`;
			const prevState = prev.get(key);
			const current = liveTagsFor(app);
			const health = app.live?.healthStatus ?? null;
			const degradedStreak = health === "Degraded" ? (prevState?.degradedStreak ?? 0) + 1 : 0;
			const promotionPhase = app.promotion?.healthPhase ?? null;
			const promotionFailed = isFailedValue(promotionPhase);
			const promotionNonPassing =
				promotionPhase !== null && !isPromotionPassing(promotionPhase) && !promotionFailed;

			const state: ComponentState = {
				liveTags: current.size > 0 ? current : (prevState?.liveTags ?? current),
				build: app.build
					? {
							pipelineRun: app.build.pipelineRun ?? null,
							status: app.build.status ?? null,
							reason: app.build.reason ?? null,
						}
					: null,
				degradedStreak,
				degradedNotified: degradedStreak === 0 ? false : (prevState?.degradedNotified ?? false),
				promotionPhase,
				promotionNonPassingSince: promotionNonPassing
					? (prevState?.promotionNonPassingSince ?? now)
					: null,
				promotionNotifiedKey: prevState?.promotionNotifiedKey ?? null,
			};

			// Baseline / first sight: record state, never notify.
			if (isBaseline || prevState === undefined) {
				next.set(key, state);
				continue;
			}

			// deploy — a NEW own-image tag while Synced (set-diff; flap-immune).
			if (current.size > 0 && app.live?.syncStatus === "Synced") {
				for (const tag of current) {
					if (prevState.liveTags.has(tag)) continue;
					const fromTag = [...prevState.liveTags].find((t) => t !== tag) ?? null;
					fresh.push({
						id: `${key}:${tag}`,
						kind: "deploy",
						severity: "info",
						component: app.component,
						env: envName,
						title: "deployed",
						detail: null,
						fromTag,
						toTag: tag,
						at: now,
						read: false,
					});
				}
			}

			// build_failed — transition into failed per pipelineRun (terminal Tekton
			// status is monotonic per run, so no anti-flap needed; a NEW failing run
			// after an old failing run notifies again).
			if (
				isFailedBuild(app.build) &&
				!(
					isFailedBuild(prevState.build) &&
					prevState.build.pipelineRun === (app.build.pipelineRun ?? null)
				)
			) {
				const runId = app.build.pipelineRun ?? app.build.finishedAt ?? "unknown";
				fresh.push({
					id: `build_failed:${key}:${runId}`,
					kind: "build_failed",
					severity: "error",
					component: app.component,
					env: envName,
					title: "build failed",
					detail: [app.build.pipelineRun, app.build.reason].filter(Boolean).join(" · ") || null,
					fromTag: null,
					toTag: null,
					at: now,
					read: false,
				});
			}

			// degraded — confirmed across DEGRADED_CONFIRM_STREAK consecutive
			// snapshots; exactly one alert per episode however long it lasts.
			if (state.degradedStreak >= DEGRADED_CONFIRM_STREAK && !state.degradedNotified) {
				state.degradedNotified = true;
				const tag = [...current].sort()[0] ?? "unknown";
				fresh.push({
					id: `degraded:${key}:${tag}`,
					kind: "degraded",
					severity: "error",
					component: app.component,
					env: envName,
					title: "degraded",
					detail: `health Degraded across ${DEGRADED_CONFIRM_STREAK} consecutive checks`,
					fromTag: null,
					toTag: null,
					at: now,
					read: false,
				});
			}

			// promotion failed (immediate) / stuck (non-passing > PROMOTION_STUCK_MS)
			// — once per drySha (freight).
			const promotionKey = app.promotion?.drySha ?? app.promotion?.hydratedSha ?? promotionPhase;
			if (promotionFailed && !isFailedValue(prevState.promotionPhase)) {
				if (state.promotionNotifiedKey !== promotionKey) {
					state.promotionNotifiedKey = promotionKey;
					fresh.push({
						id: `promotion_stuck:${key}:${promotionKey ?? "unknown"}`,
						kind: "promotion_stuck",
						severity: "error",
						component: app.component,
						env: envName,
						title: "promotion failed",
						detail: promotionPhase,
						fromTag: null,
						toTag: null,
						at: now,
						read: false,
					});
				}
			} else if (
				promotionNonPassing &&
				state.promotionNonPassingSince !== null &&
				now - state.promotionNonPassingSince > PROMOTION_STUCK_MS &&
				state.promotionNotifiedKey !== promotionKey
			) {
				state.promotionNotifiedKey = promotionKey;
				fresh.push({
					id: `promotion_stuck:${key}:${promotionKey ?? "unknown"}`,
					kind: "promotion_stuck",
					severity: "warning",
					component: app.component,
					env: envName,
					title: "promotion stuck",
					detail: `${promotionPhase} for 15m+`,
					fromTag: null,
					toTag: null,
					at: now,
					read: false,
				});
			}

			next.set(key, state);
		}
	}

	return { next, fresh };
}

/** Fixed ids for the store-driven stream_health notifications. */
export const STREAM_HEALTH_IDS = {
	eventsStalled: "stream_health:events-stalled",
	inventoryStale: "stream_health:inventory-stale",
} as const;

const KNOWN_KINDS: ReadonlySet<string> = new Set([
	"deploy",
	"build_failed",
	"degraded",
	"promotion_stuck",
	"stream_health",
]);

export function isKnownNotificationKind(kind: unknown): kind is NotificationKind {
	return typeof kind === "string" && KNOWN_KINDS.has(kind);
}

type V1Notification = {
	id: string;
	component: string;
	env: string;
	fromTag: string | null;
	toTag: string;
	at: number;
	read: boolean;
};

/** Map v1 (deploy-only) persisted entries to the v2 shape. */
export function migrateV1(entries: unknown): GitOpsNotification[] {
	if (!Array.isArray(entries)) return [];
	const out: GitOpsNotification[] = [];
	for (const entry of entries) {
		const v1 = entry as Partial<V1Notification> | null;
		if (!v1 || typeof v1.id !== "string" || typeof v1.toTag !== "string") continue;
		out.push({
			id: v1.id,
			kind: "deploy",
			severity: "info",
			component: v1.component ?? "",
			env: v1.env ?? "",
			title: "deployed",
			detail: null,
			fromTag: v1.fromTag ?? null,
			toTag: v1.toTag,
			at: typeof v1.at === "number" ? v1.at : Date.now(),
			read: Boolean(v1.read),
		});
	}
	return out;
}

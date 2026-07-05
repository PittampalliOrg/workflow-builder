/**
 * Shared wire types for the Dev hub preview surfaces (Track 1). These cross the
 * server→client boundary (remote-function returns → components), so they carry
 * only serializable data — no methods, no server-only imports. The server-side
 * legacy clients (`$lib/server/workflows/vcluster-preview`) and the application
 * services decorate their records into these shapes.
 */

/** A4/D1 lifecycle state of a Tier-2 preview. */
export type VclusterPreviewState = "hot" | "slept";

/**
 * Cluster-level record of one Tier-2 (vcluster full-isolation) preview — the
 * gateway port's return shape (a serializable subset of the legacy client's
 * `VclusterPreview`, i.e. no job/isolation plumbing).
 */
export interface VclusterPreviewRecord {
	name: string;
	/** provisioning | ready | failed | pending | terminating | claiming | slept | absent | unknown */
	phase: string;
	ready: boolean;
	/** Browsable preview URL once ready. */
	url: string | null;
	targetCluster: string;
	/** A3 backing warm-pool member id when CLAIMED (instant), else null. */
	pool: string | null;
	/** A4 lifecycle: "hot" (running) | "slept" (scaled down; a wake resumes it).
	 * null against an older SEA that doesn't emit it. */
	state: VclusterPreviewState | null;
	/** D1 owner: "user" | "pr" | null (legacy/human preview). */
	origin: string | null;
	prNumber: number | null;
	/** RFC3339 expiry (from ttlHours); the reaper tears the preview down past it. */
	expiresAt: string | null;
	/** RFC3339 last-activity stamp (touch/provision/claim). */
	lastActive: string | null;
	/** Operator hard-exemption: never slept/evicted/reaped. false when absent. */
	protected: boolean;
	/** Seconds the current provision Job has been running (cold-boot progress);
	 * null when not booting / unknown. */
	bootSeconds: number | null;
}

/**
 * One Tier-2 preview as the Dev hub renders it: a `VclusterPreviewRecord`
 * decorated with the UI-only `prUrl` (built from `prNumber` + the configured
 * repo). Kept distinct from the record so the port stays free of UI concerns.
 */
export interface VclusterPreviewSummary extends VclusterPreviewRecord {
	/** GitHub PR URL for an origin=pr preview; null otherwise. */
	prUrl: string | null;
}

/**
 * A3/A4 capacity accounting from the SEA list. `awake` counts HOT members
 * (claimed + free-hot + regular) and is what gates cold provisions; `baking`
 * counts pool up-Jobs still running (already included in `awake`); a slept
 * preview holds no compute so it never gates. `total`/`totalMax` count
 * everything (awake + slept). Nulls are 0 against an older SEA.
 */
export interface VclusterPreviewCounts {
	awake: number;
	slept: number;
	total: number;
	baking: number;
	free: number;
	claimed: number;
	recycling: number;
	max: number;
	totalMax: number;
	poolSize: number;
}

/**
 * Result of a launch: either the accepted preview, or a capacity refusal
 * returned AS DATA (never thrown) so the UI can render the meter-consistent
 * inline alert instead of a toast.
 */
export type VclusterLaunchResult =
	| { ok: true; preview: VclusterPreviewSummary; pooled: boolean }
	| { ok: false; reason: "capacity"; awake: number; max: number; message: string };

/**
 * Result of a sleep request. A 409 (protected preview, or a free/recycling pool
 * member that stays claim-ready) comes back as a typed refusal, not an error.
 */
export type PreviewSleepResult =
	| { ok: true; name: string; state: "slept"; alreadySlept: boolean }
	| { ok: false; reason: "protected" | "pool-member"; message: string };

/** Result of a wake (touch) request: whether a resume Job was started. */
export interface PreviewWakeResult {
	name: string;
	state: string;
	resuming: boolean;
}

/**
 * One PR-preview record as the Dev hub / gitops lane list it (D1). Derived from
 * the resume-safe `prPreviews.listStatuses()` snapshot + the configured repo
 * (for the PR URL). STRICTLY a read snapshot — listing it never resumes a
 * pipeline.
 */
export interface PrPreviewListItem {
	prNumber: number;
	alias: string;
	url: string | null;
	/** GitHub PR URL (always present — built from prNumber + repo). */
	prUrl: string;
	/** provisioning | seeding | ready | error | capacity_full | absent | unknown */
	state: string;
	headSha: string | null;
	services: string[];
	error: string | null;
	verify: {
		state: "started" | "skipped" | "completed" | "failed";
		reason: string | null;
		verdict: string | null;
	} | null;
	updatedAt: string | null;
}

/**
 * The `lastRun` a dev service's sidecar reports (B5 `/__status` → run history).
 * Parsed from the sidecar's raw `{ name, exitCode, durationMs, executedIn,
 * finishedAt }` into a stable UI shape.
 */
export interface SidecarLastRunView {
	cmd: string;
	exitCode: number | null;
	durationMs: number | null;
	/** #40: where the command ran ("app" bridge = real toolchain, "sidecar" =
	 * node-only fallback). null against a sidecar too old to report it. */
	executedIn: "app" | "sidecar" | null;
	finishedAt: string | null;
}

/**
 * Sanitize a user-supplied preview name into a DNS-safe, short id. Pure + shared
 * so the remote command, the application service, and the legacy client all
 * agree on preview identity (the capacity "already this name" check compares
 * against sanitized aliases).
 */
export function safePreviewName(name: string): string {
	return (
		(name || "")
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "preview"
	);
}

// Ports for label-gated per-PR previews (dev-env-v2 D1/D2).
//
// A `preview`-labeled PR gets a Tier-2 vcluster preview (claimed from the A3
// warm pool when possible) with dev-mode pods adopted for the services the PR
// touches, then the PR head is seeded into each dev pod via the sidecar/plugin
// `/__sync` (gzip tar + x-sync-token) — no image build. Hub Tekton dispatches
// `up`/`down` through `POST /api/internal/pr-previews`; teardown rides the SEA
// PR-origin lifecycle (labels/TTL) owned by the sandbox-execution-api.

/** Cluster-level view of the Tier-2 preview backing a PR (alias `pr-<n>`). */
export type PrPreviewClusterInfo = {
	ready: boolean;
	phase: string;
	url: string | null;
};

export type PrPreviewLaunchInput = {
	/** Preview alias, `pr-<n>` → tailnet host `wfb-pr-<n>`. */
	alias: string;
	prNumber: number;
	/** PR-origin TTL (SEA annotates `vcluster-preview-expires-at`). */
	ttlHours?: number;
};

/** Cold-provision outcome: capacity refusals are data, not exceptions. */
export type PrPreviewProvisionResult =
	| { ok: true }
	| { ok: false; capacity: boolean; detail: string };

export interface PrPreviewClusterPort {
	/** A3 warm-pool claim; null when the pool is empty/off (cold fallback). */
	claim(input: PrPreviewLaunchInput): Promise<PrPreviewClusterInfo | null>;
	/** Cold provision (ACTION=up). Returns `{ok:false,capacity:true}` on a 429/cap. */
	provision(input: PrPreviewLaunchInput): Promise<PrPreviewProvisionResult>;
	/** Current state by alias; null when the preview does not exist. */
	get(alias: string): Promise<PrPreviewClusterInfo | null>;
	/** A3 capacity counts (awake vs max); null against an older SEA. */
	counts(): Promise<{ awake: number; max: number } | null>;
	/** Ask SEA to evict the oldest PR-origin preview (sibling-owned endpoint).
	 * True when a member was (or may have been) reaped. */
	reap(): Promise<boolean>;
	teardown(alias: string): Promise<void>;
}

export type PrPreviewDevPodResult = {
	service: string;
	ok: boolean;
	podIp: string | null;
	syncPort: number | null;
	error?: string;
};

export interface PrPreviewDevPodPort {
	/** Adopt dev-mode pods for `services` INSIDE the preview (preview-native).
	 * Idempotent per (alias, service) — re-provision adopts the existing pod. */
	provision(input: {
		previewUrl: string;
		alias: string;
		services: string[];
		syncToken: string;
	}): Promise<PrPreviewDevPodResult[]>;
}

export type PrPreviewSeedTarget = {
	service: string;
	/** Repo subdir the service's sync tree is rooted at (`.` for the BFF). */
	repoSubdir: string;
	syncPaths: string[];
	extraSync: Array<{ from: string; to: string }>;
	podIp: string;
	syncPort: number;
	/** Dev-server app port (#41 readiness gate target; falls back to syncPort —
	 * correct for the plugin-mode BFF where they coincide). */
	appPort?: number;
	/** Known always-there route on the app port (registry healthPath, default "/").
	 * ANY http response counts as "accepting" — the status code is irrelevant. */
	healthPath?: string;
};

export interface PrPreviewSeedPort {
	/** Clone the PR head once and gzip-tar-POST each target's sync tree to its
	 * dev pod `/__sync` (x-sync-token). */
	seed(input: {
		prNumber: number;
		headSha: string;
		targets: PrPreviewSeedTarget[];
		syncToken: string;
	}): Promise<{ ok: boolean; detail: string | null }>;
}

export interface PrPreviewPullRequestPort {
	/** Changed file paths of the PR (repo-relative); null when unavailable. */
	listChangedFiles(prNumber: number): Promise<string[] | null>;
	/** Create-or-update the single comment carrying `marker` on the PR. */
	upsertStickyComment(input: {
		prNumber: number;
		marker: string;
		body: string;
	}): Promise<boolean>;
}

export interface PrPreviewVerifyPort {
	/** Dispatch the Playwright-critic workflow against the preview URL. When no
	 * critic workflow is configured, resolves `{started:false, reason}`. */
	start(input: {
		prNumber: number;
		previewUrl: string;
		headSha: string;
	}): Promise<{ started: boolean; executionId?: string | null; reason?: string | null }>;
	/** Bounded wait for the dispatched run's verdict. */
	waitForVerdict(input: {
		executionId: string;
		timeoutMs: number;
	}): Promise<{ status: string; verdict: string | null }>;
}

/** Static registry slice used to map changed paths → services (from the
 * dev-preview registry; injected so the service stays port-pure). */
export type PrPreviewRegistryEntry = {
	service: string;
	repoSubdir: string;
	syncPaths: string[];
	extraSync: Array<{ from: string; to: string }>;
	/** Dev-server port + health route (descriptor `port`/`healthPath`), carried
	 * into seed targets for the #41 readiness gate. */
	appPort?: number;
	healthPath?: string;
};

export type PrPreviewState =
	| "provisioning"
	| "seeding"
	| "ready"
	| "error"
	| "capacity_full";

/** One PR's durable pipeline record (table `pr_previews`). Written by the
 * replica running the up-pipeline at every stage transition (plus a heartbeat),
 * read by `status()` on ANY replica — the hub dispatch Task's polls are
 * conntrack-pinned to one backend, so cross-replica visibility is load-bearing,
 * not cosmetic. */
export type PrPreviewRecord = {
	prNumber: number;
	alias: string;
	url: string | null;
	state: PrPreviewState;
	headSha: string | null;
	services: string[];
	error: string | null;
	verify: PrPreviewStatus["verify"];
	/** Ownership generation (fencing token). Every `upsert` and `claimStale`
	 * bumps it; every write from a pipeline is a CAS on it, so at most ONE
	 * pipeline can ever write the row — a deposed pipeline's first failed CAS
	 * tells it to abort. This is what makes concurrent up+up (either replica),
	 * resume-vs-stalled-owner, and down-during-run deterministic. */
	gen: number;
	/** ISO timestamp of the last write (stage transition or heartbeat). */
	updatedAt: string;
};

/** Durable store for PR-preview pipeline records (fenced writes). */
export interface PrPreviewRecordStore {
	get(prNumber: number): Promise<PrPreviewRecord | null>;
	/** Insert-or-replace the row and BUMP the generation, deposing any pipeline
	 * holding the previous one. Returns the stored record (with the new gen). */
	upsert(
		record: Omit<PrPreviewRecord, "gen" | "updatedAt">,
	): Promise<PrPreviewRecord>;
	/** Fenced merge-patch: applies + stamps updatedAt iff the row exists AND
	 * still carries `gen`. Returns false when deposed or deleted — the calling
	 * pipeline must abort. `{}` is the heartbeat/ownership probe. */
	patch(
		prNumber: number,
		gen: number,
		changes: Partial<Omit<PrPreviewRecord, "prNumber" | "gen" | "updatedAt">>,
	): Promise<boolean>;
	delete(prNumber: number): Promise<void>;
	/** Recent records for UI listing (order: updatedAt desc, bounded). Rows are
	 * deleted on teardown, so "active" === "all rows". Read-only — see the
	 * service's `listStatuses()`/`peek()` for the resume-safe UI reads. */
	listActive(): Promise<PrPreviewRecord[]>;
	/**
	 * Atomically claim a STALE, NON-TERMINAL record for resume: bumps the
	 * generation + updatedAt iff state is provisioning/seeding AND updatedAt is
	 * older than `staleMs`. Returns the claimed record (new gen), or null when
	 * the row is missing, terminal, or fresh (a pipeline is heartbeating it).
	 * Exactly one concurrent caller wins (single guarded UPDATE .. RETURNING),
	 * and the gen bump fences out the previous owner even if it was merely
	 * stalled rather than dead.
	 */
	claimStale(prNumber: number, staleMs: number): Promise<PrPreviewRecord | null>;
}

export type PrPreviewStatus = {
	prNumber: number;
	alias: string;
	url: string | null;
	/** `absent` = no preview exists; `unknown` = preview exists but this BFF has
	 * no seed record for it (e.g. after a restart). */
	state: PrPreviewState | "absent" | "unknown";
	headSha: string | null;
	services: string[];
	error: string | null;
	verify: {
		state: "started" | "skipped" | "completed" | "failed";
		executionId: string | null;
		reason: string | null;
		verdict: string | null;
	} | null;
	updatedAt: string | null;
};

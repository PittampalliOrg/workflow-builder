import { env } from "$env/dynamic/private";
import { safePreviewName } from "$lib/types/dev-previews";

// Re-exported so existing importers (routes/tests) keep the same entrypoint; the
// canonical (shared, client-safe) definition lives in $lib/types/dev-previews.
export { safePreviewName };

/**
 * Tier-2 full-isolation preview environments (vcluster).
 *
 * Unlike Tier-1 light previews (a per-run hot-reload Sandbox; see
 * `dev-preview.ts`), a Tier-2 preview is a whole vcluster running the full app
 * stack (BFF + orchestrator + function-router) against the shared host data tier
 * + an isolated per-preview DB — for end-to-end workflow execution / multi-service
 * / infra changes.
 *
 * The BFF is unprivileged, so it never runs `vcluster create`/`kubectl`. It asks
 * the privileged `sandbox-execution-api` (`/internal/vcluster-preview`) to create
 * a Job that runs the proven provision/deploy/teardown runner as a cluster-admin
 * provisioner SA. See stacks `.../workflow-builder-preview-vcluster/`.
 */

export interface VclusterPreview {
	name: string;
	job: string;
	targetCluster: "dev";
	fallbackCluster: "ryzen";
	isolationTier: "tier-2-vcluster";
	/** provisioning | ready | failed | pending | terminating | claiming | absent | unknown */
	phase: string;
	ready: boolean;
	tailnetHost: string | null;
	/** Browsable preview URL once ready. */
	url: string | null;
	/** A3: the backing warm-pool member id (pool-<n>) when this preview was CLAIMED, else null.
	 * Presence means the preview came up instantly from the pool rather than a cold provision. */
	pool: string | null;
	/** A4 lifecycle state: "hot" (running) | "slept" (control plane + workloads scaled down;
	 * a touch/claim wakes it). Null against an older SEA that doesn't emit it. */
	state: "hot" | "slept" | null;
	/** D1: who this preview belongs to — "user" | "pr" | null (legacy/human). */
	origin: string | null;
	/** D1: the GitHub PR a pr-origin preview serves. */
	prNumber: number | null;
	/** D1: RFC3339 expiry (from ttlHours); the reaper tears the preview down past it. */
	expiresAt: string | null;
	/** A4: RFC3339 last-activity stamp (touch endpoint / provision / claim). */
	lastActive: string | null;
	/** Operator hard-exemption (`vcluster-preview-protected=true`): the reaper /
	 * eviction / sleep logic never touches it. false when the SEA omits it. */
	protected: boolean;
	/** Seconds the current provision (up) Job has been running — cold-boot
	 * progress. null when not booting / unknown / against an older SEA. */
	bootSeconds: number | null;
}

/** A3/A4 capacity accounting (from the SEA list): `awake` counts HOT members only (claimed +
 * free-hot + regular — a slept preview holds no compute so it doesn't gate cold provisions);
 * `total` counts everything (awake + slept) against `totalMax` (0 = unlimited). */
export interface VclusterPreviewCounts {
	awake: number;
	slept: number;
	total: number;
	/** Pool up-Jobs still running (already counted in `awake`) — surfaced so the
	 * capacity meter can show mid-bake members as a distinct, pulsing segment. */
	baking: number;
	free: number;
	claimed: number;
	recycling: number;
	max: number;
	totalMax: number;
	poolSize: number;
}

/** D1 lifecycle fields accepted by claim/provision/launch (all optional; omitted = the
 * legacy/human preview shape — never auto-reaped, never evicted). */
export interface VclusterPreviewLifecycleParams {
	/** "user" (a human asked for it) | "pr" (PR-preview automation; evictable). */
	origin?: "user" | "pr";
	/** The GitHub PR a pr-origin preview serves. */
	prNumber?: number;
	/** Per-preview lifetime in hours; SEA stamps `vcluster-preview-expires-at`. */
	ttlHours?: number;
}

function sandboxExecutionApiUrl(): string | null {
	const raw = (
		env.SANDBOX_EXECUTION_API_URL ??
		env.HOST_EXECUTION_API_URL ??
		process.env.SANDBOX_EXECUTION_API_URL ??
		process.env.HOST_EXECUTION_API_URL ??
		""
	).trim();
	return raw ? raw.replace(/\/+$/, "") : null;
}

function internalToken(): string {
	return env.INTERNAL_API_TOKEN ?? process.env.INTERNAL_API_TOKEN ?? "";
}

/** SEA call failure carrying the HTTP status (e.g. 429 = capacity refusal). */
export class VclusterPreviewHttpError extends Error {
	constructor(
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "VclusterPreviewHttpError";
	}
}

async function call(
	method: "POST" | "GET" | "DELETE",
	path: string,
	body?: unknown,
): Promise<Record<string, unknown>> {
	const baseUrl = sandboxExecutionApiUrl();
	if (!baseUrl) throw new Error("SANDBOX_EXECUTION_API_URL not configured");
	const token = internalToken();
	const res = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			"Content-Type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		const detail =
			typeof data.detail === "string"
				? data.detail
				: `vcluster-preview ${method} ${path} failed (HTTP ${res.status})`;
		throw new VclusterPreviewHttpError(detail, res.status);
	}
	return data;
}

function lifecycleFields(
	params: VclusterPreviewLifecycleParams,
): Record<string, unknown> {
	return {
		...(params.origin ? { origin: params.origin } : {}),
		...(params.prNumber != null ? { prNumber: params.prNumber } : {}),
		...(params.ttlHours != null ? { ttlHours: params.ttlHours } : {}),
	};
}

function toPreview(d: Record<string, unknown>): VclusterPreview {
	return {
		name: String(d.name ?? ""),
		job: String(d.job ?? ""),
		targetCluster: "dev",
		fallbackCluster: "ryzen",
		isolationTier: "tier-2-vcluster",
		phase: typeof d.phase === "string" ? d.phase : String(d.status ?? "unknown"),
		ready: d.ready === true,
		tailnetHost: typeof d.tailnetHost === "string" ? d.tailnetHost : null,
		url: typeof d.url === "string" ? d.url : null,
		pool: typeof d.pool === "string" ? d.pool : null,
		state: d.state === "slept" ? "slept" : d.state === "hot" ? "hot" : null,
		origin: typeof d.origin === "string" ? d.origin : null,
		prNumber:
			typeof d.prNumber === "number" && Number.isFinite(d.prNumber)
				? d.prNumber
				: null,
		expiresAt: typeof d.expiresAt === "string" ? d.expiresAt : null,
		lastActive: typeof d.lastActive === "string" ? d.lastActive : null,
		protected: d.protected === true,
		bootSeconds:
			typeof d.bootSeconds === "number" && Number.isFinite(d.bootSeconds)
				? d.bootSeconds
				: null,
	};
}

/**
 * A3: claim a pre-baked warm-pool member (instant). Returns the claimed preview, or `null`
 * when the pool is empty/off (SEA 404) — the caller then falls back to a cold provision. A
 * claim consumes an already-awake member, so it is not capacity-gated.
 */
export async function claimVclusterPreview(
	params: {
		name: string;
		devMode?: boolean;
		user?: string;
	} & VclusterPreviewLifecycleParams,
): Promise<VclusterPreview | null> {
	const baseUrl = sandboxExecutionApiUrl();
	if (!baseUrl) throw new Error("SANDBOX_EXECUTION_API_URL not configured");
	const name = safePreviewName(params.name);
	const token = internalToken();
	const post = async (extras: Record<string, unknown>) =>
		fetch(`${baseUrl}/internal/vcluster-preview/claim`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			body: JSON.stringify({
				name,
				...(params.devMode ? { devMode: true } : {}),
				...(params.user ? { user: params.user } : {}),
				...extras,
			}),
		});
	const extras = lifecycleFields(params);
	let res = await post(extras);
	// Tolerate an SEA that predates the PR-preview lifecycle fields: a 422
	// validation reject retries once WITHOUT them (labels/TTL are then absent —
	// the GC backstop still tears the preview down on PR close).
	if (res.status === 422 && Object.keys(extras).length > 0) {
		res = await post({});
	}
	if (res.status === 404) return null; // no free member / pool off → cold-provision fallback
	const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) {
		const detail =
			typeof data.detail === "string"
				? data.detail
				: `vcluster-preview claim failed (HTTP ${res.status})`;
		throw new VclusterPreviewHttpError(detail, res.status);
	}
	return toPreview(data);
}

/** Cold-provision (or re-provision) a Tier-2 preview vcluster (ACTION=up). Returns immediately
 * (202). This is the fallback when the warm pool has no free member. */
export async function provisionVclusterPreview(
	params: {
		name: string;
		daprVersion?: string;
		tailnetHost?: string;
		previewDb?: string;
		/** Interactive dev preview: provision so the dev image can adopt the prod BFF
		 * over HTTPS (runner sets EXPOSE_DEV_POD=false). The adopt:true dev/preview is
		 * triggered separately after provisioning. */
		devMode?: boolean;
	} & VclusterPreviewLifecycleParams,
): Promise<VclusterPreview> {
	const name = safePreviewName(params.name);
	const base: Record<string, unknown> = {
		name,
		action: "up",
		...(params.daprVersion ? { daprVersion: params.daprVersion } : {}),
		...(params.tailnetHost ? { tailnetHost: params.tailnetHost } : {}),
		...(params.previewDb ? { previewDb: params.previewDb } : {}),
		...(params.devMode ? { previewDevMode: true } : {}),
	};
	const extras = lifecycleFields(params);
	try {
		const data = await call("POST", "/internal/vcluster-preview", {
			...base,
			...extras,
		});
		return toPreview(data);
	} catch (err) {
		// Pre-lifecycle SEA: retry once without the PR fields on a validation reject.
		if (
			err instanceof VclusterPreviewHttpError &&
			err.status === 422 &&
			Object.keys(extras).length > 0
		) {
			const data = await call("POST", "/internal/vcluster-preview", base);
			return toPreview(data);
		}
		throw err;
	}
}

/**
 * Launch a Tier-2 preview: A3 claim-first (instant from the warm pool), falling back to a cold
 * provision when the pool is empty/off. Returns immediately (202). Note: capacity admission for
 * the COLD fallback lives in the route (it must count awake members); a claim needs no cap.
 */
export async function launchVclusterPreview(
	params: {
		name: string;
		daprVersion?: string;
		tailnetHost?: string;
		previewDb?: string;
		devMode?: boolean;
		user?: string;
	} & VclusterPreviewLifecycleParams,
): Promise<VclusterPreview> {
	const claimed = await claimVclusterPreview({
		name: params.name,
		devMode: params.devMode,
		user: params.user,
		origin: params.origin,
		prNumber: params.prNumber,
		ttlHours: params.ttlHours,
	});
	if (claimed) {
		// A4: launching IS activity. A FRESH claim already stamped last-active inside the
		// atomic label flip, but an IDEMPOTENT re-claim of an existing alias does not —
		// touch covers it (and a touch on a slept re-claim is a harmless second resume
		// signal). Best-effort: a touch failure never fails the launch.
		await touchVclusterPreview(claimed.name).catch(() => undefined);
		return claimed;
	}
	return provisionVclusterPreview(params);
}

/** A4 activity ping + wake-up. Stamps `vcluster-preview-last-active` on the preview; touching
 * a SLEPT preview starts a resume-Job (`resuming: true` — poll getVclusterPreview until ready).
 * Call this from points where a preview is actively USED (launch, dev-preview provision) —
 * never from list/status reads (reads don't count as activity). */
export async function touchVclusterPreview(name: string): Promise<{
	name: string;
	state: string;
	resuming: boolean;
	lastActive: string | null;
}> {
	const data = await call(
		"POST",
		`/internal/vcluster-preview/${encodeURIComponent(safePreviewName(name))}/touch`,
	);
	return {
		name: String(data.name ?? name),
		state: typeof data.state === "string" ? data.state : "hot",
		resuming: data.resuming === true,
		lastActive: typeof data.lastActive === "string" ? data.lastActive : null,
	};
}

/** Current status of a Tier-2 preview (job phase == environment readiness). Accepts a claimed
 * preview's alias — SEA resolves it to the backing member. */
/** A4 explicit sleep: scale the preview's control plane + workloads down (a
 * touch/claim wakes it). SEA `POST /internal/vcluster-preview/{name}/sleep`. A
 * 409 (protected preview, or a free/recycling pool member that stays
 * claim-ready) surfaces as a `VclusterPreviewHttpError` with status 409 for the
 * caller to classify; `alreadySlept` is true when it was already asleep. */
export async function sleepVclusterPreview(name: string): Promise<{
	name: string;
	state: "slept";
	alreadySlept: boolean;
}> {
	const data = await call(
		"POST",
		`/internal/vcluster-preview/${encodeURIComponent(safePreviewName(name))}/sleep`,
	);
	return {
		name: String(data.name ?? name),
		state: "slept",
		alreadySlept: data.alreadySlept === true,
	};
}

export async function getVclusterPreview(name: string): Promise<VclusterPreview> {
	const data = await call(
		"GET",
		`/internal/vcluster-preview/${encodeURIComponent(safePreviewName(name))}`,
	);
	return toPreview(data);
}

/** List active Tier-2 previews. Free/recycling pool members are hidden; a claimed member shows
 * under the user's alias. */
export async function listVclusterPreviews(): Promise<VclusterPreview[]> {
	const { previews } = await listVclusterPreviewsWithCounts();
	return previews;
}

function toCounts(d: unknown): VclusterPreviewCounts | null {
	if (!d || typeof d !== "object") return null;
	const c = d as Record<string, unknown>;
	const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
	return {
		awake: num(c.awake),
		slept: num(c.slept),
		total: num(c.total),
		baking: num(c.baking),
		free: num(c.free),
		claimed: num(c.claimed),
		recycling: num(c.recycling),
		max: num(c.max),
		totalMax: num(c.totalMax),
		poolSize: num(c.poolSize),
	};
}

/** List Tier-2 previews AND the A3 capacity counts (awake includes free pool members, so the
 * launch cap counts them). `counts` is null against an older SEA that doesn't emit it. */
export async function listVclusterPreviewsWithCounts(): Promise<{
	previews: VclusterPreview[];
	counts: VclusterPreviewCounts | null;
}> {
	const data = await call("GET", "/internal/vcluster-previews");
	const arr = Array.isArray(data.previews) ? data.previews : [];
	return {
		previews: arr.map((d) => toPreview(d as Record<string, unknown>)),
		counts: toCounts(data.counts),
	};
}

/** Tear down a Tier-2 preview (drops the per-preview DB + `vcluster delete`). */
export async function teardownVclusterPreview(
	name: string,
): Promise<VclusterPreview> {
	const data = await call(
		"DELETE",
		`/internal/vcluster-preview/${encodeURIComponent(safePreviewName(name))}`,
	);
	return toPreview(data);
}

/**
 * D1 capacity relief: ask SEA to evict the oldest PR-ORIGIN preview (humans are
 * never evicted — policy lives in SEA, sibling-owned `POST /internal/vcluster-preview/reap`).
 * Returns false (never throws) when the endpoint is missing (older SEA) or
 * nothing was reapable; the caller then surfaces `capacity_full`.
 */
export async function reapVclusterPreviews(): Promise<boolean> {
	try {
		const data = await call("POST", "/internal/vcluster-preview/reap");
		return data.reaped !== false;
	} catch {
		return false;
	}
}

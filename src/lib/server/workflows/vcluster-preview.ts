import { env } from "$env/dynamic/private";

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
}

/** A3 capacity accounting (from the SEA list): awake = every non-terminating preview vcluster
 * (claimed + free-hot + regular), so the launch cap counts pooled members too. */
export interface VclusterPreviewCounts {
	awake: number;
	free: number;
	claimed: number;
	recycling: number;
	max: number;
	poolSize: number;
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

/** Sanitize a user-supplied preview name into a DNS-safe, short id. */
export function safePreviewName(name: string): string {
	return (name || "")
		.toLowerCase()
		.replace(/[^a-z0-9-]/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40) || "preview";
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

/** D1 PR-preview lifecycle fields (SEA contract: `origin`/`prNumber`/`ttlHours`
 * label the preview namespace so the SEA reaper can TTL/evict PR previews —
 * humans never). Optional everywhere; an older SEA simply ignores them. */
export interface VclusterPreviewLifecycleParams {
	origin?: "user" | "pr";
	prNumber?: number;
	ttlHours?: number;
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
	if (claimed) return claimed;
	return provisionVclusterPreview(params);
}

/** Current status of a Tier-2 preview (job phase == environment readiness). Accepts a claimed
 * preview's alias — SEA resolves it to the backing member. */
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
		free: num(c.free),
		claimed: num(c.claimed),
		recycling: num(c.recycling),
		max: num(c.max),
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

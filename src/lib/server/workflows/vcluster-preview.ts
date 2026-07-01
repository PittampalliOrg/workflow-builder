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
	/** provisioning | ready | failed | pending | terminating | absent | unknown */
	phase: string;
	ready: boolean;
	tailnetHost: string | null;
	/** Browsable preview URL once ready. */
	url: string | null;
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
		throw new Error(detail);
	}
	return data;
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
	};
}

/** Launch (or re-provision) a Tier-2 preview vcluster. Returns immediately (202). */
export async function launchVclusterPreview(params: {
	name: string;
	daprVersion?: string;
	tailnetHost?: string;
	previewDb?: string;
	/** Interactive dev preview: provision so the dev image can adopt the prod BFF
	 * over HTTPS (runner sets EXPOSE_DEV_POD=false). The adopt:true dev/preview is
	 * triggered separately after provisioning. */
	devMode?: boolean;
}): Promise<VclusterPreview> {
	const name = safePreviewName(params.name);
	const data = await call("POST", "/internal/vcluster-preview", {
		name,
		action: "up",
		...(params.daprVersion ? { daprVersion: params.daprVersion } : {}),
		...(params.tailnetHost ? { tailnetHost: params.tailnetHost } : {}),
		...(params.previewDb ? { previewDb: params.previewDb } : {}),
		...(params.devMode ? { previewDevMode: true } : {}),
	});
	return toPreview(data);
}

/** Current status of a Tier-2 preview (job phase == environment readiness). */
export async function getVclusterPreview(name: string): Promise<VclusterPreview> {
	const data = await call(
		"GET",
		`/internal/vcluster-preview/${encodeURIComponent(safePreviewName(name))}`,
	);
	return toPreview(data);
}

/** List active Tier-2 previews (from the provisioning Jobs). */
export async function listVclusterPreviews(): Promise<VclusterPreview[]> {
	const data = await call("GET", "/internal/vcluster-previews");
	const arr = Array.isArray(data.previews) ? data.previews : [];
	return arr.map((d) => toPreview(d as Record<string, unknown>));
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

/**
 * Per-service dev-preview registry (P3).
 *
 * Maps a logical microservice id → how to stand up its per-run dev preview: the
 * dev image (built from `skaffold/dev/<svc>/Dockerfile.dev`), the dev-server port
 * + health path, where source lives, and HOW edits are synced in:
 *   - `plugin`  : the dev image hosts `/__sync` itself on the dev port
 *                 (workflow-builder's in-process Vite plugin). syncPort = port.
 *   - `sidecar` : a language-agnostic dev-sync-sidecar receives `/__sync` into a
 *                 shared emptyDir the dev server watches (any service, unmodified
 *                 image). syncPort = 8001.
 *
 * The dev images' own CMD already runs the hot-reload server (vite / `uvicorn
 * --reload` / `pnpm dev` → tsx watch), so `command` is null = use the image CMD.
 *
 * Resolved by the BFF dev-preview route from the `service` param and forwarded to
 * sandbox-execution-api. Adding a service = one entry here + its dev image + a
 * per-service tailnet LB (stacks). The dev image refs come from env so stacks
 * pins them (digest) without a code change; the literals are dev fallbacks.
 */

export type DevPreviewSyncMode = "plugin" | "sidecar";

export interface DevPreviewDescriptor {
	/** Logical service id; also the `dev-preview-service` pod label + LB selector. */
	service: string;
	/** Env var holding the digest-pinned dev image (stacks-controlled); falls back to `imageFallback`. */
	imageEnvKey: string;
	imageFallback: string;
	/** Dev-server container port (browsable). */
	port: number;
	/** Readiness/startup probe path. */
	healthPath: string;
	/** Where the dev server runs + where source is synced. */
	workdir: string;
	syncMode: DevPreviewSyncMode;
	/** Agent `/__sync` target port (plugin → port; sidecar → 8001). */
	syncPort: number;
	/** `owner/repo` the agent clones. */
	repoUrl: string;
	/** Subdir of the repo whose source maps onto the dev image's workdir ("." = repo root). */
	repoSubdir: string;
	/** Globs (relative to repoSubdir) the agent tars + pushes on /__sync. */
	syncPaths: string[];
	/** Per-service tailnet hostname (stacks LB), for the human browse URL. */
	tailnetHost: string;
}

export const DEV_PREVIEW_SERVICES: Record<string, DevPreviewDescriptor> = {
	"workflow-builder": {
		service: "workflow-builder",
		imageEnvKey: "WORKFLOW_BUILDER_DEV_IMAGE",
		imageFallback:
			"ghcr.io/pittampalliorg/workflow-builder-dev@sha256:b5347497cb6c6ce03b8a9359d5392ab88a5173de3316ea43e54c148750053b96",
		port: 3000,
		healthPath: "/",
		workdir: "/app",
		syncMode: "plugin",
		syncPort: 3000,
		repoUrl: "PittampalliOrg/workflow-builder",
		repoSubdir: ".",
		syncPaths: ["src"],
		tailnetHost: "wfb-preview-ryzen.tail286401.ts.net",
	},
	"workflow-orchestrator": {
		service: "workflow-orchestrator",
		imageEnvKey: "WORKFLOW_ORCHESTRATOR_DEV_IMAGE",
		imageFallback: "ghcr.io/pittampalliorg/workflow-orchestrator-dev:latest",
		port: 8080,
		healthPath: "/healthz",
		workdir: "/app",
		syncMode: "sidecar",
		syncPort: 8001,
		repoUrl: "PittampalliOrg/workflow-builder",
		repoSubdir: "services/workflow-orchestrator",
		// uvicorn --reload-dir /app watches everything; sync the python source trees.
		syncPaths: ["app.py", "core", "activities", "workflows"],
		tailnetHost: "orchestrator-preview-ryzen.tail286401.ts.net",
	},
	"function-router": {
		service: "function-router",
		imageEnvKey: "FUNCTION_ROUTER_DEV_IMAGE",
		imageFallback: "ghcr.io/pittampalliorg/function-router-dev:latest",
		port: 8080,
		healthPath: "/healthz",
		workdir: "/app",
		syncMode: "sidecar",
		syncPort: 8001,
		repoUrl: "PittampalliOrg/workflow-builder",
		repoSubdir: "services/function-router",
		// tsx watch follows the import graph from src/.
		syncPaths: ["src", "config"],
		tailnetHost: "function-router-preview-ryzen.tail286401.ts.net",
	},
};

export const DEFAULT_DEV_PREVIEW_SERVICE = "workflow-builder";

export function resolveDevPreviewDescriptor(
	service: string | null | undefined,
): DevPreviewDescriptor {
	const id = (service || DEFAULT_DEV_PREVIEW_SERVICE).trim();
	const d = DEV_PREVIEW_SERVICES[id];
	if (!d) {
		const known = Object.keys(DEV_PREVIEW_SERVICES).join(", ");
		throw new Error(`Unknown dev-preview service "${id}". Known: ${known}`);
	}
	return d;
}

/** Resolve the dev image: stacks-pinned env var, else the descriptor fallback. */
export function resolveDevPreviewImage(
	d: DevPreviewDescriptor,
	env: Record<string, string | undefined>,
): string {
	return (env[d.imageEnvKey] || "").trim() || d.imageFallback;
}

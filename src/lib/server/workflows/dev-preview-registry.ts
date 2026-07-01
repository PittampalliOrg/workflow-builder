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
	/** Base branch a captured version Promotes against (default "main"). */
	baseBranch?: string;
	/** Per-service tailnet hostname (stacks LB), for the human browse URL. */
	tailnetHost: string;
	/**
	 * Dapr-shadow (P3.1): the service's startup needs Dapr (secrets/state/workflow)
	 * so the preview pod gets a daprd sidecar. Isolated by a unique app-id (own task
	 * hub) + a dev pubsub component (`pubsubName`), booting against the real DB via
	 * daprd's secret fetch. Omit/false = lightweight no-deps preview.
	 */
	needsDapr?: boolean;
	/** Isolated dev pubsub component name (forwarded as PUBSUB_NAME env). */
	pubsubName?: string;
	/**
	 * Functional preview (the app actually runs, not UI-only). Provisions a
	 * per-preview Postgres database (`preview_<id>`, app self-migrates on boot) +
	 * reuses the prod config/secrets via `envFrom`. For app services like the BFF.
	 */
	functional?: boolean;
	/**
	 * Suppress the orchestrator-only Dapr-shadow env knobs (DAPR_CONFIG_STORE,
	 * PUBSUB_NAME) when this service just needs a daprd sidecar (e.g. the BFF).
	 */
	applyDaprShadowDefaults?: boolean;
	/** envFrom sources (configmaps/secret) to reuse the prod app's config + DATABASE_URL. */
	envFrom?: Array<Record<string, unknown>>;
	/** Extra plain env for the dev container (e.g. ORIGIN). */
	extraEnv?: Record<string, string>;
	/**
	 * Preview-native adopt (in-preview agentic dev loop, P1): when a run requests
	 * `mode: "preview-native"`, the dev pod runs INSIDE a Tier-2 vcluster preview
	 * and REPLACES the preview's prod Deployment — it adopts the preview's own
	 * Service (so the preview's existing tailnet URL serves live edits) and reuses
	 * the preview's own DB/secrets (no throwaway DB). These name the Service /
	 * Deployment / Dapr app-id to take over; each defaults to `service` when unset
	 * (true for the BFF, where all three are `workflow-builder`).
	 */
	adoptService?: string;
	adoptDeployment?: string;
	adoptDaprAppId?: string;
}

export const DEV_PREVIEW_SERVICES: Record<string, DevPreviewDescriptor> = {
	"workflow-builder": {
		service: "workflow-builder",
		imageEnvKey: "WORKFLOW_BUILDER_DEV_IMAGE",
		imageFallback:
			"ghcr.io/pittampalliorg/workflow-builder-dev@sha256:d272c036902a8d79e33abba3f40abfef67fb025eb772e14f59d0be8bf94715a3",
		port: 3000,
		healthPath: "/",
		workdir: "/app",
		syncMode: "plugin",
		syncPort: 3000,
		repoUrl: "PittampalliOrg/workflow-builder",
		repoSubdir: ".",
		syncPaths: ["src"],
		baseBranch: "main",
		tailnetHost: "wfb-preview-ryzen.tail286401.ts.net",
		// Functional preview: the BFF actually runs against its own preview DB +
		// a daprd sidecar (to service-invoke the backend). Reuses the prod
		// config/secrets via envFrom; the per-preview DATABASE_URL overrides the
		// shared one (delivered via a per-preview Secret).
		functional: true,
		needsDapr: true,
		applyDaprShadowDefaults: false,
		envFrom: [
			{ configMapRef: { name: "workflow-builder-otel-config", optional: true } },
			{ configMapRef: { name: "workflow-builder-flipt-config", optional: true } },
			{ secretRef: { name: "workflow-builder-secrets" } },
		],
		extraEnv: { ORIGIN: "http://wfb-preview-ryzen.tail286401.ts.net" },
		// Preview-native adopt: take over the preview's `workflow-builder`
		// Service/Deployment/app-id so the preview URL serves the HMR build.
		adoptService: "workflow-builder",
		adoptDeployment: "workflow-builder",
		adoptDaprAppId: "workflow-builder",
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
		// Startup fetches DATABASE_URL from Dapr secrets + runs `wfr.start()`.
		needsDapr: true,
		pubsubName: "pubsub-dev",
	},
	"swebench-coordinator": {
		service: "swebench-coordinator",
		imageEnvKey: "SWEBENCH_COORDINATOR_DEV_IMAGE",
		imageFallback: "ghcr.io/pittampalliorg/swebench-coordinator-dev:latest",
		port: 8080,
		healthPath: "/healthz",
		workdir: "/app",
		syncMode: "sidecar",
		syncPort: 8001,
		repoUrl: "PittampalliOrg/workflow-builder",
		repoSubdir: "services/swebench-coordinator",
		syncPaths: ["app.py", "src"],
		tailnetHost: "swebench-coordinator-preview-ryzen.tail286401.ts.net",
		// Boots without DB but still needs daprd for `wfr.start()`.
		needsDapr: true,
		pubsubName: "pubsub-dev",
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

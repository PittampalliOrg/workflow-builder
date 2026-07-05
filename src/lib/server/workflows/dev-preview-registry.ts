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
 *                 image). syncPort = 8001. The sidecar also serves `/__export`
 *                 (version capture), `/__status`, and `/__run` (allowlisted deps/
 *                 test commands) — the same surface the Vite plugin gives the BFF.
 *                 `/__run` commands execute in the APP container via its exec
 *                 bridge (#40, `services/dev-sync-sidecar/exec-bridge.mjs`/`.py`
 *                 on pod-localhost:8002) so they get the service's real
 *                 toolchain; the sidecar only runs them itself as a fallback
 *                 (`executedIn: "sidecar"`) against pre-bridge images.
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

/** Language family — drives the DEFAULT syncPaths when a descriptor omits them. */
export type DevPreviewLanguage = "node" | "python";

/** An extra source tree staged into the sync tar from OUTSIDE the service's repoSubdir. */
export interface DevPreviewExtraSync {
	/** Source dir relative to `repoSubdir` (e.g. "../shared/workflow-data-contract"). */
	from: string;
	/** Destination dir relative to the tar root (unpacks under the pod workdir). */
	to: string;
}

export interface DevPreviewDescriptor {
	/** Logical service id; also the `dev-preview-service` pod label + LB selector. */
	service: string;
	/** Language family — selects the DEFAULT syncPaths when `syncPaths` is omitted. */
	language: DevPreviewLanguage;
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
	/**
	 * Globs (relative to repoSubdir) the agent tars + pushes on /__sync. OMIT to take
	 * the language-family default (DEFAULT_SYNC_PATHS) — safe because both /__sync and
	 * /__export filter non-existent paths. Use `devPreviewSyncPaths()` to resolve.
	 */
	syncPaths?: string[];
	/**
	 * Extra source trees to STAGE into the sync tar from OUTSIDE `repoSubdir` (e.g. a
	 * shared contract package a service consumes). The sync client copies `from`
	 * (relative to repoSubdir) into `to` (relative to the tar root, i.e. the pod
	 * workdir) before tarring, so a cross-package edit hot-reloads too.
	 */
	extraSync?: DevPreviewExtraSync[];
	/**
	 * In-pod dependency (re)install, run via the sidecar's POST /__run?cmd=deps when
	 * the sync client detects a manifest-checksum change (package.json/pnpm-lock/.npmrc
	 * for node; requirements.txt/pyproject.toml/uv.lock for python). Runs in the
	 * pod-LOCAL workdir (emptyDir / image FS) — NEVER on the JuiceFS shared workspace
	 * (small-file installs there are catastrophically slow, ~11 min documented).
	 */
	depsCommand?: string;
	/**
	 * Named fast test lanes runnable in-pod via POST /__run?cmd=<name> (e.g.
	 * `contract`). Forwarded into the sidecar's DEV_SYNC_COMMANDS_JSON allowlist under
	 * each name; `deps` is reserved for `depsCommand`.
	 */
	testCommands?: Record<string, string>;
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
	/**
	 * Preview-native adopt over HTTPS: co-locate an nginx tls-terminator sidecar in
	 * the dev pod (the prod Deployment's tls-terminator is not otherwise copied), so
	 * the prod tailnet LB (targetPort `https-tls`) serves the adopted dev pod over
	 * HTTPS. Set for the BFF, which the prod LB fronts via its tls-terminator.
	 */
	adoptTlsTerminator?: boolean;
}

/** DEFAULT syncPaths by language family — applied when a descriptor omits `syncPaths`. */
export const DEFAULT_SYNC_PATHS: Record<DevPreviewLanguage, string[]> = {
	node: ["src", "config"],
	python: ["app.py", "src", "core", "activities", "workflows", "tests"],
};

export const DEV_PREVIEW_SERVICES: Record<string, DevPreviewDescriptor> = {
	"workflow-builder": {
		service: "workflow-builder",
		language: "node",
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
		// B4: sync the shared workflow-data contract so a TS↔Python contract edit
		// hot-reloads the BFF too (the dev image also bakes it — see Dockerfile.dev).
		// process.cwd() is /app in the pod, so it lands at the path the contract test
		// reads (services/shared/workflow-data-contract/fixtures).
		syncPaths: ["src", "services/shared/workflow-data-contract"],
		baseBranch: "main",
		tailnetHost: "wfb-preview-ryzen.tail286401.ts.net",
		// In-pod dep reinstall on a package.json/pnpm-lock/.npmrc change; vite HMR
		// picks up the refreshed node_modules with no restart.
		depsCommand: "pnpm install --no-frozen-lockfile",
		// Fast contract lane: the single shared-fixture vitest (seconds), cwd /app.
		// `check` (svelte-check), `test-unit` (vitest), and `boundaries` (depcruise)
		// give an in-preview generator/critic the same gates run in CI via /__run.
		testCommands: {
			contract:
				"node_modules/.bin/vitest run src/routes/api/internal/workflow-data/workflow-data-contract.test.ts",
			check: "pnpm check",
			"test-unit": "pnpm test:unit",
			boundaries: "pnpm check:boundaries",
		},
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
		// The prod BFF serves HTTPS via an nginx tls-terminator sidecar; co-locate it
		// on the adopted dev pod so the preview's tailnet URL stays HTTPS in dev mode.
		adoptTlsTerminator: true,
	},
	"workflow-orchestrator": {
		service: "workflow-orchestrator",
		language: "python",
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
		// `tests` + `subscriptions` so a contract/subscription edit hot-reloads too.
		syncPaths: ["app.py", "core", "activities", "workflows", "tests", "subscriptions"],
		// B4: stage the shared contract into /app/.contract-fixtures (the dev image
		// bakes it there + sets WORKFLOW_DATA_CONTRACT_FIXTURE_DIR); this re-syncs a
		// live fixture edit so `contract` reruns against it.
		extraSync: [{ from: "../shared/workflow-data-contract", to: ".contract-fixtures" }],
		// In-pod dep reinstall on a requirements/pyproject/uv.lock change; touch app.py
		// so uvicorn --reload restarts against the refreshed site-packages.
		depsCommand: "pip install -r requirements.txt && touch /app/app.py",
		// Fast contract lane: the single migration/contract pytest (Dapr-free, seconds).
		testCommands: {
			contract: "python -m pytest tests/test_workflow_data_activity_migration.py -q",
		},
		tailnetHost: "orchestrator-preview-ryzen.tail286401.ts.net",
		// Startup fetches DATABASE_URL from Dapr secrets + runs `wfr.start()`.
		needsDapr: true,
		pubsubName: "pubsub-dev",
	},
	"swebench-coordinator": {
		service: "swebench-coordinator",
		language: "python",
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
		language: "node",
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
		// tsx watch doesn't rescan node_modules; touch the entrypoint after install.
		depsCommand: "pnpm install --no-frozen-lockfile && touch src/index.ts",
		tailnetHost: "function-router-preview-ryzen.tail286401.ts.net",
	},
	"mcp-gateway": {
		service: "mcp-gateway",
		language: "node",
		imageEnvKey: "MCP_GATEWAY_DEV_IMAGE",
		// No stacks pin exists yet (like swebench-coordinator) → :latest fallback.
		imageFallback: "ghcr.io/pittampalliorg/mcp-gateway-dev:latest",
		port: 8080,
		healthPath: "/health",
		workdir: "/app",
		syncMode: "sidecar",
		syncPort: 8001,
		repoUrl: "PittampalliOrg/workflow-builder",
		repoSubdir: "services/mcp-gateway",
		// syncPaths omitted → node default (["src","config"]); mcp-gateway has no
		// config/ dir, which the sync/export path filters out harmlessly.
		depsCommand: "pnpm install --no-frozen-lockfile && touch src/index.ts",
		tailnetHost: "mcp-gateway-preview-ryzen.tail286401.ts.net",
	},
	"workflow-mcp-server": {
		service: "workflow-mcp-server",
		language: "node",
		imageEnvKey: "WORKFLOW_MCP_SERVER_DEV_IMAGE",
		// No stacks pin exists yet → :latest fallback (dev image built from the new
		// skaffold/dev/workflow-mcp-server/Dockerfile.dev).
		imageFallback: "ghcr.io/pittampalliorg/workflow-mcp-server-dev:latest",
		port: 3200,
		healthPath: "/health",
		workdir: "/app",
		syncMode: "sidecar",
		syncPort: 8001,
		repoUrl: "PittampalliOrg/workflow-builder",
		repoSubdir: "services/workflow-mcp-server",
		// syncPaths omitted → node default (["src","config"]).
		depsCommand: "pnpm install --no-frozen-lockfile && touch src/index.ts",
		tailnetHost: "workflow-mcp-server-preview-ryzen.tail286401.ts.net",
	},
};

export const DEFAULT_DEV_PREVIEW_SERVICE = "workflow-builder";

/** Effective syncPaths: the descriptor's explicit list, else the language default. */
export function devPreviewSyncPaths(d: DevPreviewDescriptor): string[] {
	return d.syncPaths?.length ? d.syncPaths : DEFAULT_SYNC_PATHS[d.language];
}

/**
 * The named-command allowlist SEA stamps into the sidecar's DEV_SYNC_COMMANDS_JSON:
 * the reserved `deps` name = depsCommand, plus each `testCommands` entry under its
 * own name. Empty when the service declares neither (then /__run just 404s).
 */
export function devPreviewCommands(d: DevPreviewDescriptor): Record<string, string> {
	const cmds: Record<string, string> = {};
	if (d.depsCommand) cmds.deps = d.depsCommand;
	for (const [name, cmd] of Object.entries(d.testCommands ?? {})) {
		if (cmd) cmds[name] = cmd;
	}
	return cmds;
}

export function resolveDevPreviewDescriptor(
	service: string | null | undefined,
	env: Record<string, string | undefined> = process.env,
): DevPreviewDescriptor {
	const id = (service || DEFAULT_DEV_PREVIEW_SERVICE).trim();
	const d = DEV_PREVIEW_SERVICES[id];
	if (!d) {
		const known = Object.keys(DEV_PREVIEW_SERVICES).join(", ");
		throw new Error(`Unknown dev-preview service "${id}". Known: ${known}`);
	}
	// Sidecar-transport flag (parallel rollout): flip a plugin-mode service to
	// sidecar transport. The dev image's own HMR server stays the engine; the
	// dev-sync-sidecar becomes the /__sync + /__export transport into the shared
	// emptyDir workdir. Default (unset) keeps today's in-process Vite plugin path.
	if (
		d.syncMode === "plugin" &&
		(env.WFB_DEV_SYNC_MODE || "").trim().toLowerCase() === "sidecar"
	) {
		return { ...d, syncMode: "sidecar", syncPort: 8001 };
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

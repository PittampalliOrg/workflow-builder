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
 *                 toolchain; preview-native bridge failures fail closed.
 *
 * The dev images' own CMD already runs the hot-reload server (vite / `uvicorn
 * --reload` / `pnpm dev` → tsx watch), so `command` is null = use the image CMD.
 *
 * Resolved by the BFF dev-preview route from the `service` param and forwarded to
 * sandbox-execution-api. Adding a service = one entry here + its dev image; any
 * public path is declared in `stacksRequirements.externalRoutes` and served by
 * the PreviewEnvironment's single host-terminated ingress. The dev image refs
 * come from env so stacks pins them by digest or full git SHA without a code
 * change. Missing/mutable pins fail closed; this registry never embeds a second
 * version source of truth.
 */

import { createHash } from "node:crypto";
import { posix as pathPosix } from "node:path";
import { resolveImagePin } from "$lib/server/execution/image-pins";

export type DevPreviewSyncMode = "plugin" | "sidecar";

/** Language family — drives the DEFAULT syncPaths when a descriptor omits them. */
export type DevPreviewLanguage = "node" | "python";

export type DevPreviewServiceCapability =
  | "host-throwaway"
  | "preview-native"
  | "acceptance-build";

export interface DevPreviewBuild {
  /** Image repository without a mutable tag. */
  image: string;
  /** Docker build context relative to the repository root. */
  context: string;
  /** Dockerfile relative to the repository root. */
  dockerfile: string;
}

export interface PreviewActivationBuild extends DevPreviewBuild {
  pipeline: string;
  statusContext: "preview/activation-images";
}

export interface DevPreviewNativeAdoption {
  deployment: string;
  service: string;
  /** Null for services that do not run a Dapr sidecar. */
  daprAppId: string | null;
}

export interface DevPreviewCapabilities {
  /** Standalone dev pod on the physical dev cluster. */
  hostThrowaway: true;
  /** Null until the vCluster baseline contains an adoptable Deployment + Service. */
  previewNative: DevPreviewNativeAdoption | null;
  /** Production image built when a captured version is accepted. */
  acceptanceBuild: DevPreviewBuild;
  /** Clean vCluster replay is supported for this production image. */
  acceptanceReplay: boolean;
}

export interface DevPreviewStacksRequirements {
  /** The BFF must receive this service's immutable dev image through imageEnvKey. */
  devImagePin: "required-immutable";
  /** Routes on the single host-terminated PreviewEnvironment ingress. */
  externalRoutes: readonly Readonly<{
    pathPrefix: string;
    backendPort: number;
  }>[];
}

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
  /** Env var holding the immutable dev image pin (stacks-controlled). */
  imageEnvKey: string;
  /** Dev image build metadata; the version is deliberately owned by stacks. */
  devBuild: DevPreviewBuild;
  /** Explicit execution capabilities and production acceptance build. */
  capabilities: DevPreviewCapabilities;
  /** Cross-repository resources stacks must provide for this entry. */
  stacksRequirements: DevPreviewStacksRequirements;
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
  /** Stable DNS role; the physical target cluster and tailnet are runtime config. */
  tailnetHostnameRole: string;
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
  /**
   * envFrom sources that exist only inside an isolated preview vCluster. Never
   * forward these refs to an agent-mutable host-throwaway pod.
   */
  previewNativeEnvFrom?: Array<Record<string, unknown>>;
  /** Extra plain env for the dev container (e.g. ORIGIN). */
  extraEnv?: Record<string, string>;
}

/** Runtime paths that need preview evidence but are not hot-sync services. */
export interface PreviewCatalogExtensionDescriptor {
  service: string;
  repoUrl: "PittampalliOrg/workflow-builder";
  repoSubdir: string;
  baseBranch: "main";
  changedPaths: readonly string[];
  capabilities: Readonly<{
    acceptanceBuild: DevPreviewBuild | null;
    acceptanceReplay: boolean;
    activationBuild: PreviewActivationBuild | null;
    workloadAdoption: DevPreviewNativeAdoption | null;
  }>;
}

export interface DevPreviewCaptureMapping {
  /** Path inside the dev pod workdir. */
  from: string;
  /** Destination relative to the repository root. */
  to: string;
}

function safeDevPreviewName(value: string, maxLength = 52): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (
    (normalized || "execution").slice(0, maxLength).replace(/-+$/g, "") ||
    "execution"
  );
}

function safeDevPreviewResourceName(value: string, maxLength = 63): string {
  const normalized =
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "execution";
  if (normalized.length <= maxLength) return normalized;
  const digest = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 10);
  const prefixLength = maxLength - digest.length - 1;
  const prefix =
    normalized.slice(0, prefixLength).replace(/-+$/g, "") || "execution";
  return `${prefix}-${digest}`;
}

/** Canonical Sandbox identity shared with sandbox-execution-api. */
export function devPreviewSandboxName(
  executionId: string,
  service: string,
): string {
  const canonicalService = resolveDevPreviewDescriptor(service).service;
  return safeDevPreviewResourceName(
    `wfb-dev-preview-${safeDevPreviewName(canonicalService, 24)}-${executionId}`,
  );
}

/** Build inputs staged under a hidden pod path for capture, never hot-applied. */
export function devPreviewCaptureOnly(
  d: DevPreviewDescriptor,
): DevPreviewExtraSync[] {
  const serviceRoot = d.repoSubdir === "." ? "." : d.repoSubdir;
  const relativeToService = (repositoryPath: string) => {
    const relative = pathPosix.relative(serviceRoot, repositoryPath);
    if (!relative || pathPosix.isAbsolute(relative)) {
      throw new Error(
        `Dev-preview build input is not a repository-relative file (${d.service}: ${repositoryPath})`,
      );
    }
    return relative;
  };
  return [
    {
      from: relativeToService(d.capabilities.acceptanceBuild.dockerfile),
      to: ".preview-capture/production.Dockerfile",
    },
    {
      from: relativeToService(d.devBuild.dockerfile),
      to: ".preview-capture/development.Dockerfile",
    },
  ];
}

export interface DevPreviewServiceSetRejection {
  service: string;
  reason: "unknown-service" | "unsupported-capability";
}

export interface DevPreviewServiceSetResolution {
  /** Unique service ids in canonical catalog order. */
  services: string[];
  rejected: DevPreviewServiceSetRejection[];
}

/** DEFAULT syncPaths by language family — applied when a descriptor omits `syncPaths`. */
export const DEFAULT_SYNC_PATHS: Record<DevPreviewLanguage, string[]> = {
  node: ["src", "config", "package.json", "pnpm-lock.yaml"],
  python: [
    "app.py",
    "src",
    "core",
    "activities",
    "workflows",
    "tests",
    "requirements.txt",
    "pyproject.toml",
    "uv.lock",
  ],
};

function requiredStacksResources(
  externalRoutes: DevPreviewStacksRequirements["externalRoutes"] = [],
): DevPreviewStacksRequirements {
  return {
    devImagePin: "required-immutable",
    externalRoutes,
  };
}

export const DEV_PREVIEW_SERVICES: Record<string, DevPreviewDescriptor> = {
  "workflow-builder": {
    service: "workflow-builder",
    language: "node",
    imageEnvKey: "WORKFLOW_BUILDER_DEV_IMAGE",
    devBuild: {
      image: "ghcr.io/pittampalliorg/workflow-builder-dev",
      context: ".",
      dockerfile: "skaffold/dev/workflow-builder/Dockerfile.dev",
    },
    capabilities: {
      hostThrowaway: true,
      acceptanceReplay: true,
      previewNative: {
        deployment: "workflow-builder",
        service: "workflow-builder",
        daprAppId: "workflow-builder",
      },
      acceptanceBuild: {
        image: "ghcr.io/pittampalliorg/workflow-builder",
        context: ".",
        dockerfile: "Dockerfile",
      },
    },
    stacksRequirements: requiredStacksResources([
      { pathPrefix: "/", backendPort: 3000 },
    ]),
    port: 3000,
    healthPath: "/",
    workdir: "/app",
    // Seed the baked image into the renderer-owned emptyDir before Vite starts,
    // then receive atomic uploads through the same sidecar adapter as peers.
    // Directly renaming a baked lower-overlay directory can fail with EXDEV.
    syncMode: "sidecar",
    syncPort: 8001,
    repoUrl: "PittampalliOrg/workflow-builder",
    repoSubdir: ".",
    // B4: sync the shared workflow-data contract so a TS↔Python contract edit
    // hot-reloads the BFF too (the dev image also bakes it — see Dockerfile.dev).
    // process.cwd() is /app in the pod, so it lands at the path the contract test
    // reads (services/shared/workflow-data-contract/fixtures).
    syncPaths: [
      "src",
      "static",
      "drizzle",
      "lib",
      "scripts",
      "services/shared/workflow-data-contract",
      "package.json",
      "pnpm-lock.yaml",
      ".npmrc",
      "svelte.config.js",
      "vite.config.ts",
      "tsconfig.json",
      "components.json",
      "drizzle.config.ts",
      "server-prod.js",
    ],
    baseBranch: "main",
    tailnetHostnameRole: "wfb",
    // In-pod dep reinstall on a package.json/pnpm-lock/.npmrc change; vite HMR
    // picks up the refreshed node_modules with no restart.
    depsCommand: "CI=true pnpm install --no-frozen-lockfile",
    // Fast contract lane: the single shared-fixture vitest (seconds), cwd /app.
    // `migrate` applies hot-synced Drizzle migrations against this preview's DB;
    // the runtime script serializes callers with a Postgres advisory lock and
    // Drizzle's ledger makes repeats idempotent. The remaining commands expose
    // the same gates run in CI to an in-preview generator/critic via /__run.
    testCommands: {
      migrate: "node scripts/db-migrate-runtime.mjs",
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
      {
        configMapRef: {
          name: "workflow-builder-otel-config",
          optional: true,
        },
      },
      {
        configMapRef: {
          name: "workflow-builder-flipt-config",
          optional: true,
        },
      },
      { secretRef: { name: "workflow-builder-secrets" } },
    ],
  },
  "workflow-orchestrator": {
    service: "workflow-orchestrator",
    language: "python",
    imageEnvKey: "WORKFLOW_ORCHESTRATOR_DEV_IMAGE",
    devBuild: {
      image: "ghcr.io/pittampalliorg/workflow-orchestrator-dev",
      context: ".",
      dockerfile: "skaffold/dev/workflow-orchestrator/Dockerfile.dev",
    },
    capabilities: {
      hostThrowaway: true,
      acceptanceReplay: true,
      previewNative: {
        deployment: "workflow-orchestrator",
        service: "workflow-orchestrator",
        daprAppId: "workflow-orchestrator",
      },
      acceptanceBuild: {
        image: "ghcr.io/pittampalliorg/workflow-orchestrator",
        context: "services/workflow-orchestrator",
        dockerfile: "services/workflow-orchestrator/Dockerfile",
      },
    },
    stacksRequirements: requiredStacksResources(),
    port: 8080,
    healthPath: "/healthz",
    workdir: "/app",
    syncMode: "sidecar",
    syncPort: 8001,
    repoUrl: "PittampalliOrg/workflow-builder",
    repoSubdir: "services/workflow-orchestrator",
    // uvicorn --reload-dir /app watches everything; sync the python source trees.
    // `tests` + `subscriptions` so a contract/subscription edit hot-reloads too.
    syncPaths: [
      "app.py",
      "core",
      "activities",
      "workflows",
      "tests",
      "subscriptions",
      "requirements.txt",
      "pyproject.toml",
      "uv.lock",
    ],
    // B4: stage the shared contract into /app/.contract-fixtures (the dev image
    // bakes it there + sets WORKFLOW_DATA_CONTRACT_FIXTURE_DIR); this re-syncs a
    // live fixture edit so `contract` reruns against it.
    extraSync: [
      {
        from: "../shared/workflow-data-contract",
        to: ".contract-fixtures",
      },
    ],
    // In-pod dep reinstall on a requirements/pyproject/uv.lock change; touch app.py
    // so uvicorn --reload restarts against the refreshed site-packages.
    depsCommand: "pip install -r requirements.txt && touch /app/app.py",
    // Fast contract lane: the single migration/contract pytest (Dapr-free, seconds).
    testCommands: {
      contract:
        "python -m pytest tests/test_workflow_data_activity_migration.py -q",
    },
    tailnetHostnameRole: "orchestrator",
    // Startup fetches DATABASE_URL from Dapr secrets + runs `wfr.start()`.
    needsDapr: true,
    pubsubName: "pubsub-dev",
    previewNativeEnvFrom: [
      { configMapRef: { name: "workflow-orchestrator-config" } },
      { configMapRef: { name: "workflow-orchestrator-otel-config" } },
      { configMapRef: { name: "workflow-orchestrator-dapr-config" } },
      {
        secretRef: {
          name: "workflow-orchestrator-secrets",
          optional: true,
        },
      },
    ],
    // The first exact-SHA fan-out establishes dependency baselines for every
    // selected service. workflow-builder can therefore be absent from Dapr for
    // longer than the production startup default while its dev server reloads.
    // Keep the strict read-model check, but let this dev-only process outlive
    // that bounded dependency/HMR window and recover without replacing the pod.
    extraEnv: {
      WORKFLOW_DATA_READ_MODEL_STARTUP_TIMEOUT_SECONDS: "300",
      WORKFLOW_DATA_READ_MODEL_STARTUP_RETRY_INTERVAL_SECONDS: "1",
    },
  },
  "swebench-coordinator": {
    service: "swebench-coordinator",
    language: "python",
    imageEnvKey: "SWEBENCH_COORDINATOR_DEV_IMAGE",
    devBuild: {
      image: "ghcr.io/pittampalliorg/swebench-coordinator-dev",
      context: ".",
      dockerfile: "skaffold/dev/swebench-coordinator/Dockerfile.dev",
    },
    capabilities: {
      hostThrowaway: true,
      acceptanceReplay: false,
      previewNative: null,
      acceptanceBuild: {
        image: "ghcr.io/pittampalliorg/swebench-coordinator",
        context: "services/swebench-coordinator",
        dockerfile: "services/swebench-coordinator/Dockerfile",
      },
    },
    stacksRequirements: requiredStacksResources(),
    port: 8080,
    healthPath: "/healthz",
    workdir: "/app",
    syncMode: "sidecar",
    syncPort: 8001,
    repoUrl: "PittampalliOrg/workflow-builder",
    repoSubdir: "services/swebench-coordinator",
    syncPaths: ["src", "pyproject.toml"],
    depsCommand: "pip install -e . && touch src/app.py",
    tailnetHostnameRole: "swebench-coordinator",
    // Boots without DB but still needs daprd for `wfr.start()`.
    needsDapr: true,
    pubsubName: "pubsub-dev",
  },
  "function-router": {
    service: "function-router",
    language: "node",
    imageEnvKey: "FUNCTION_ROUTER_DEV_IMAGE",
    devBuild: {
      image: "ghcr.io/pittampalliorg/function-router-dev",
      context: ".",
      dockerfile: "skaffold/dev/function-router/Dockerfile.dev",
    },
    capabilities: {
      hostThrowaway: true,
      acceptanceReplay: true,
      previewNative: {
        deployment: "function-router",
        service: "function-router",
        daprAppId: "function-router",
      },
      acceptanceBuild: {
        image: "ghcr.io/pittampalliorg/function-router",
        context: ".",
        dockerfile: "services/function-router/Dockerfile",
      },
    },
    stacksRequirements: requiredStacksResources(),
    port: 8080,
    healthPath: "/healthz",
    workdir: "/app",
    syncMode: "sidecar",
    syncPort: 8001,
    repoUrl: "PittampalliOrg/workflow-builder",
    repoSubdir: "services/function-router",
    // tsx watch follows the import graph from src/.
    syncPaths: ["src", "config", "package.json", "pnpm-lock.yaml"],
    // tsx watch doesn't rescan node_modules; touch the entrypoint after install.
    depsCommand:
      "CI=true pnpm install --no-frozen-lockfile && touch src/index.ts",
    tailnetHostnameRole: "function-router",
    needsDapr: true,
    applyDaprShadowDefaults: false,
    previewNativeEnvFrom: [
      { configMapRef: { name: "function-router-config" } },
      { configMapRef: { name: "function-router-dapr-config" } },
      { secretRef: { name: "function-router-secrets", optional: true } },
    ],
  },
  "mcp-gateway": {
    service: "mcp-gateway",
    language: "node",
    imageEnvKey: "MCP_GATEWAY_DEV_IMAGE",
    devBuild: {
      image: "ghcr.io/pittampalliorg/mcp-gateway-dev",
      context: ".",
      dockerfile: "skaffold/dev/mcp-gateway/Dockerfile.dev",
    },
    capabilities: {
      hostThrowaway: true,
      acceptanceReplay: true,
      previewNative: {
        deployment: "mcp-gateway",
        service: "mcp-gateway",
        daprAppId: null,
      },
      acceptanceBuild: {
        image: "ghcr.io/pittampalliorg/mcp-gateway",
        context: ".",
        dockerfile: "services/mcp-gateway/Dockerfile",
      },
    },
    stacksRequirements: requiredStacksResources(),
    port: 8080,
    healthPath: "/health",
    workdir: "/app",
    syncMode: "sidecar",
    syncPort: 8001,
    repoUrl: "PittampalliOrg/workflow-builder",
    repoSubdir: "services/mcp-gateway",
    // syncPaths omitted → node default; mcp-gateway has no
    // config/ dir, which the sync/export path filters out harmlessly.
    depsCommand:
      "CI=true pnpm install --no-frozen-lockfile && touch src/index.ts",
    tailnetHostnameRole: "mcp-gateway",
    envFrom: [{ secretRef: { name: "workflow-builder-secrets" } }],
    extraEnv: {
      WORKFLOW_BUILDER_URL:
        "http://workflow-builder.workflow-builder.svc.cluster.local:3000",
      OTEL_SDK_DISABLED: "true",
    },
  },
  "workflow-mcp-server": {
    service: "workflow-mcp-server",
    language: "node",
    imageEnvKey: "WORKFLOW_MCP_SERVER_DEV_IMAGE",
    devBuild: {
      image: "ghcr.io/pittampalliorg/workflow-mcp-server-dev",
      context: ".",
      dockerfile: "skaffold/dev/workflow-mcp-server/Dockerfile.dev",
    },
    capabilities: {
      hostThrowaway: true,
      acceptanceReplay: true,
      previewNative: {
        deployment: "workflow-mcp-server",
        service: "workflow-mcp-server",
        daprAppId: null,
      },
      acceptanceBuild: {
        image: "ghcr.io/pittampalliorg/workflow-mcp-server",
        context: "services/workflow-mcp-server",
        dockerfile: "services/workflow-mcp-server/Dockerfile",
      },
    },
    stacksRequirements: requiredStacksResources([
      { pathPrefix: "/mcp", backendPort: 3200 },
    ]),
    port: 3200,
    healthPath: "/health",
    workdir: "/app",
    syncMode: "sidecar",
    syncPort: 8001,
    repoUrl: "PittampalliOrg/workflow-builder",
    repoSubdir: "services/workflow-mcp-server",
    // syncPaths omitted → node default.
    depsCommand:
      "CI=true pnpm install --no-frozen-lockfile && touch src/index.ts",
    tailnetHostnameRole: "workflow-mcp-server",
    previewNativeEnvFrom: [{ secretRef: { name: "workflow-builder-secrets" } }],
  },
};

export const PREVIEW_CATALOG_EXTENSIONS: Record<
  string,
  PreviewCatalogExtensionDescriptor
> = {
  "sandbox-execution-api": {
    service: "sandbox-execution-api",
    repoUrl: "PittampalliOrg/workflow-builder",
    repoSubdir: "services/sandbox-execution-api",
    baseBranch: "main",
    changedPaths: ["services/sandbox-execution-api"],
    capabilities: {
      acceptanceBuild: {
        image: "ghcr.io/pittampalliorg/sandbox-execution-api",
        context: "services/sandbox-execution-api",
        dockerfile: "services/sandbox-execution-api/Dockerfile",
      },
      acceptanceReplay: true,
      activationBuild: null,
      workloadAdoption: {
        deployment: "sandbox-execution-api",
        service: "sandbox-execution-api",
        daprAppId: null,
      },
    },
  },
  "dev-sync-sidecar": {
    service: "dev-sync-sidecar",
    repoUrl: "PittampalliOrg/workflow-builder",
    repoSubdir: "services/dev-sync-sidecar",
    baseBranch: "main",
    changedPaths: ["services/dev-sync-sidecar"],
    capabilities: {
      acceptanceBuild: null,
      acceptanceReplay: false,
      activationBuild: {
        image: "ghcr.io/pittampalliorg/dev-sync-sidecar",
        context: "services/dev-sync-sidecar",
        dockerfile: "services/dev-sync-sidecar/Dockerfile",
        pipeline: "build-dev-sync-sidecar-activation",
        statusContext: "preview/activation-images",
      },
      workloadAdoption: null,
    },
  },
};

export const DEFAULT_DEV_PREVIEW_SERVICE = "workflow-builder";

/** Resolve physical browse DNS without embedding a cluster or tailnet in code/catalog. */
export function devPreviewTailnetHost(
  descriptor: DevPreviewDescriptor,
): string | null {
  const serviceKey = descriptor.service.toUpperCase().replace(/-/g, "_");
  const explicit =
    process.env[`DEV_PREVIEW_${serviceKey}_TAILNET_HOST`]?.trim();
  if (explicit) return explicit;
  const suffix = process.env.DEV_PREVIEW_TAILNET_SUFFIX?.trim().replace(
    /^\.+/,
    "",
  );
  if (!suffix) return null;
  const cluster = (process.env.DEV_PREVIEW_CLUSTER_NAME ?? "dev").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(cluster)) {
    throw new Error("DEV_PREVIEW_CLUSTER_NAME is not a valid DNS label");
  }
  return `${descriptor.tailnetHostnameRole}-preview-${cluster}.${suffix}`;
}

export function devPreviewBrowseUrl(
  descriptor: DevPreviewDescriptor,
): string | null {
  const host = devPreviewTailnetHost(descriptor);
  if (!host) return null;
  const scheme =
    process.env.DEV_PREVIEW_TAILNET_SCHEME?.trim().toLowerCase() === "http"
      ? "http"
      : "https";
  return `${scheme}://${host}`;
}

/** Effective syncPaths: the descriptor's explicit list, else the language default. */
export function devPreviewSyncPaths(d: DevPreviewDescriptor): string[] {
  return [
    ...(d.syncPaths?.length ? d.syncPaths : DEFAULT_SYNC_PATHS[d.language]),
  ];
}

function repositoryPath(d: DevPreviewDescriptor, relativePath: string): string {
  const base = d.repoSubdir === "." ? "" : d.repoSubdir;
  const resolved = pathPosix.normalize(pathPosix.join(base, relativePath));
  if (
    !resolved ||
    resolved === ".." ||
    resolved.startsWith("../") ||
    pathPosix.isAbsolute(resolved)
  ) {
    throw new Error(
      `Dev-preview path escapes repository root (${d.service}: ${relativePath})`,
    );
  }
  return resolved.replace(/^\.\//, "");
}

/**
 * Reversible capture plan. Direct sync paths map back below repoSubdir; staged
 * extraSync trees map from their in-pod destination to their original repo path.
 */
export function devPreviewCaptureMappings(
  d: DevPreviewDescriptor,
): DevPreviewCaptureMapping[] {
  const mappings = [
    ...devPreviewSyncPaths(d).map((path) => ({
      from: path,
      to: repositoryPath(d, path),
    })),
    ...(d.extraSync ?? []).map((extra) => ({
      from: extra.to,
      to: repositoryPath(d, extra.from),
    })),
    ...devPreviewCaptureOnly(d).map((extra) => ({
      from: extra.to,
      to: repositoryPath(d, extra.from),
    })),
  ];
  return [
    ...new Map(
      mappings.map((mapping) => [`${mapping.from}\0${mapping.to}`, mapping]),
    ).values(),
  ].sort((a, b) => a.to.localeCompare(b.to) || a.from.localeCompare(b.from));
}

/** Repo-relative paths that select this service for PR preview/build fan-out. */
export function devPreviewChangedPaths(d: DevPreviewDescriptor): string[] {
  const paths = new Set(
    devPreviewCaptureMappings(d).map((mapping) => mapping.to),
  );
  if (d.repoSubdir !== ".") paths.add(d.repoSubdir.replace(/\/+$/, ""));
  paths.add(d.devBuild.dockerfile);
  paths.add(d.capabilities.acceptanceBuild.dockerfile);
  if (
    d.devBuild.context === "." ||
    d.capabilities.acceptanceBuild.context === "."
  ) {
    paths.add(".dockerignore");
  }
  return [...paths].sort();
}

function supportsCapability(
  d: DevPreviewDescriptor,
  capability: DevPreviewServiceCapability,
): boolean {
  if (capability === "host-throwaway") return d.capabilities.hostThrowaway;
  if (capability === "preview-native")
    return d.capabilities.previewNative !== null;
  return d.capabilities.acceptanceBuild !== null;
}

export function canonicalDevPreviewServices(
  capability?: DevPreviewServiceCapability,
): string[] {
  return Object.values(DEV_PREVIEW_SERVICES)
    .filter(
      (descriptor) => !capability || supportsCapability(descriptor, capability),
    )
    .map((descriptor) => descriptor.service)
    .sort();
}

/** Validate and canonicalize a requested set without silently dropping entries. */
export function resolveRequestedDevPreviewServiceSet(
  requested: readonly string[],
  capability: DevPreviewServiceCapability,
): DevPreviewServiceSetResolution {
  const requestedIds = [
    ...new Set(requested.map((service) => service.trim())),
  ].sort();
  const rejected: DevPreviewServiceSetRejection[] = [];
  const services: string[] = [];
  for (const service of requestedIds) {
    const descriptor = DEV_PREVIEW_SERVICES[service];
    if (!descriptor) {
      rejected.push({ service, reason: "unknown-service" });
      continue;
    }
    if (!supportsCapability(descriptor, capability)) {
      rejected.push({ service, reason: "unsupported-capability" });
      continue;
    }
    services.push(service);
  }
  return { services, rejected };
}

export function canonicalPreviewAcceptanceServices(): string[] {
  return [
    ...Object.values(DEV_PREVIEW_SERVICES)
      .filter((descriptor) => descriptor.capabilities.acceptanceReplay)
      .map((descriptor) => descriptor.service),
    ...Object.values(PREVIEW_CATALOG_EXTENSIONS)
      .filter(
        (descriptor) =>
          descriptor.capabilities.acceptanceReplay &&
          descriptor.capabilities.acceptanceBuild !== null,
      )
      .map((descriptor) => descriptor.service),
  ].sort();
}

export function resolveRequestedPreviewAcceptanceServiceSet(
  requested: readonly string[],
): DevPreviewServiceSetResolution {
  const supported = new Set(canonicalPreviewAcceptanceServices());
  const known = new Set([
    ...Object.keys(DEV_PREVIEW_SERVICES),
    ...Object.keys(PREVIEW_CATALOG_EXTENSIONS),
  ]);
  const requestedIds = [
    ...new Set(requested.map((service) => service.trim())),
  ].sort();
  const rejected: DevPreviewServiceSetRejection[] = [];
  const services: string[] = [];
  for (const service of requestedIds) {
    if (!known.has(service)) {
      rejected.push({ service, reason: "unknown-service" });
    } else if (!supported.has(service)) {
      rejected.push({ service, reason: "unsupported-capability" });
    } else {
      services.push(service);
    }
  }
  return { services, rejected };
}

export function resolvePreviewAcceptanceBuild(
  service: string,
): DevPreviewBuild {
  const development = DEV_PREVIEW_SERVICES[service];
  if (development?.capabilities.acceptanceReplay) {
    return development.capabilities.acceptanceBuild;
  }
  const extension = PREVIEW_CATALOG_EXTENSIONS[service];
  if (
    extension?.capabilities.acceptanceReplay &&
    extension.capabilities.acceptanceBuild
  ) {
    return extension.capabilities.acceptanceBuild;
  }
  throw new Error(
    `${service} does not support immutable preview acceptance replay`,
  );
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

export const DEV_PREVIEW_CATALOG_SCHEMA_VERSION = 3;

export const DEV_PREVIEW_CATALOG_PATH_POLICY = Object.freeze({
  ignoredPathPrefixes: Object.freeze([
    ".dependency-cruiser.cjs",
    ".gitignore",
    "AGENTS.md",
    "CLAUDE.md",
    "GANs.md",
    "LICENSE",
    "README.md",
    "docs",
    "playwright.config.ts",
    "tsconfig.depcruise.json",
  ]),
  unsupportedPathPrefixes: Object.freeze([
    ".github/CODEOWNERS",
    ".github/actions",
    ".github/workflows",
    "drizzle/0102_preview_accepted_image_receipts.sql",
    "scripts/governance",
    "scripts/sync-dev-preview-service-catalog.ts",
    "services/shared/dev-preview-service-catalog.json",
    "src/lib/server/application/adapters/preview-accepted-images.ts",
    "src/lib/server/application/adapters/preview-control.ts",
    "src/lib/server/application/adapters/preview-github-app.ts",
    "src/lib/server/application/index.ts",
    "src/lib/server/application/ports/preview-accepted-images.ts",
    "src/lib/server/application/ports/preview-control.ts",
    "src/lib/server/application/preview-acceptance-broker.ts",
    "src/lib/server/application/preview-accepted-image-reuse.ts",
    "src/lib/server/application/preview-accepted-images.ts",
    "src/lib/server/application/preview-activation-gate.ts",
    "src/lib/server/application/preview-gate-reconciler.ts",
    "src/lib/server/application/preview-gate-requirements.ts",
    "src/lib/server/db/schema.ts",
    "src/lib/server/internal-auth.ts",
    "src/lib/server/preview-control-capability.ts",
    "src/lib/server/workflows/dev-preview-registry.ts",
    "src/routes/api/internal/preview-control",
  ]),
  unmatchedPathPolicy: "unsupported" as const,
});

function devPreviewCatalogPayload() {
  const developmentServices = canonicalDevPreviewServices().map((service) => {
    const d = DEV_PREVIEW_SERVICES[service];
    const previewNative = d.capabilities.previewNative;
    return {
      service: d.service,
      capabilities: {
        acceptanceBuild: true,
        acceptanceReplay: d.capabilities.acceptanceReplay,
        activationBuild: false,
        hostThrowaway: true,
        hotSync: true,
        previewNative: previewNative !== null,
      },
      source: {
        repository: d.repoUrl,
        repoSubdir: d.repoSubdir,
        baseBranch: d.baseBranch ?? "main",
        syncPaths: devPreviewSyncPaths(d),
        extraSync: (d.extraSync ?? []).map((entry) => ({ ...entry })),
        captureOnly: devPreviewCaptureOnly(d).map((entry) => ({ ...entry })),
        captureMappings: devPreviewCaptureMappings(d),
        changedPaths: devPreviewChangedPaths(d),
      },
      development: {
        language: d.language,
        imageEnvKey: d.imageEnvKey,
        build: { ...d.devBuild },
        port: d.port,
        healthPath: d.healthPath,
        workdir: d.workdir,
        syncMode: d.syncMode,
        syncPort: d.syncPort,
        depsCommand: d.depsCommand ?? null,
        testCommands: { ...(d.testCommands ?? {}) },
        needsDapr: d.needsDapr === true,
        pubsubName: d.pubsubName ?? null,
        functional: d.functional === true,
        applyDaprShadowDefaults: d.applyDaprShadowDefaults ?? null,
        envFrom: (d.envFrom ?? []).map((entry) => ({ ...entry })),
        previewNativeEnvFrom: (d.previewNativeEnvFrom ?? []).map((entry) => ({
          ...entry,
        })),
        env: { ...(d.extraEnv ?? {}) },
      },
      acceptance: { ...d.capabilities.acceptanceBuild },
      activation: null,
      stacksRequirements: {
        devImagePin: {
          required: d.stacksRequirements.devImagePin === "required-immutable",
          envKey: d.imageEnvKey,
          image: d.devBuild.image,
          policy: "digest-or-git-sha",
        },
        externalRoutes: d.stacksRequirements.externalRoutes.map((route) => ({
          ...route,
          backendService: d.service,
          tlsTermination: "host",
        })),
        workloadAdoption: previewNative ? { ...previewNative } : null,
      },
    };
  });
  const extensionServices = Object.values(PREVIEW_CATALOG_EXTENSIONS).map(
    (descriptor) => ({
      service: descriptor.service,
      capabilities: {
        acceptanceBuild: descriptor.capabilities.acceptanceBuild !== null,
        acceptanceReplay: descriptor.capabilities.acceptanceReplay,
        activationBuild: descriptor.capabilities.activationBuild !== null,
        hostThrowaway: false,
        hotSync: false,
        previewNative: false,
      },
      source: {
        repository: descriptor.repoUrl,
        repoSubdir: descriptor.repoSubdir,
        baseBranch: descriptor.baseBranch,
        syncPaths: [],
        extraSync: [],
        captureOnly: [],
        captureMappings: [],
        changedPaths: [...descriptor.changedPaths],
      },
      development: null,
      acceptance: descriptor.capabilities.acceptanceBuild
        ? { ...descriptor.capabilities.acceptanceBuild }
        : null,
      activation: descriptor.capabilities.activationBuild
        ? { ...descriptor.capabilities.activationBuild }
        : null,
      stacksRequirements: {
        devImagePin: null,
        externalRoutes: [],
        workloadAdoption: descriptor.capabilities.workloadAdoption
          ? { ...descriptor.capabilities.workloadAdoption }
          : null,
      },
    }),
  );
  return {
    schemaVersion: DEV_PREVIEW_CATALOG_SCHEMA_VERSION,
    source: "src/lib/server/workflows/dev-preview-registry.ts",
    pathPolicy: DEV_PREVIEW_CATALOG_PATH_POLICY,
    services: [...developmentServices, ...extensionServices].sort((a, b) =>
      a.service.localeCompare(b.service),
    ),
  };
}

const DEV_PREVIEW_CATALOG_PAYLOAD = canonicalizeJson(
  devPreviewCatalogPayload(),
);

export const DEV_PREVIEW_CATALOG_DIGEST = `sha256:${createHash("sha256")
  .update(JSON.stringify(DEV_PREVIEW_CATALOG_PAYLOAD))
  .digest("hex")}` as `sha256:${string}`;

export function devPreviewCatalogDocument() {
  return canonicalizeJson({
    ...(DEV_PREVIEW_CATALOG_PAYLOAD as Record<string, unknown>),
    catalogDigest: DEV_PREVIEW_CATALOG_DIGEST,
  });
}

export function serializeDevPreviewCatalog(): string {
  return `${JSON.stringify(devPreviewCatalogDocument(), null, 2)}\n`;
}

/**
 * The named-command allowlist SEA stamps into the sidecar's DEV_SYNC_COMMANDS_JSON:
 * the reserved `deps` name = depsCommand, plus each `testCommands` entry under its
 * own name. Empty when the service declares neither (then /__run just 404s).
 */
export function devPreviewCommands(
  d: DevPreviewDescriptor,
): Record<string, string> {
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
  // Transitional override for any remaining plugin-mode catalog service. The
  // dev image's own HMR server stays the engine; the sidecar owns transport into
  // a shared emptyDir workdir.
  if (
    d.syncMode === "plugin" &&
    (env.WFB_DEV_SYNC_MODE || "").trim().toLowerCase() === "sidecar"
  ) {
    return { ...d, syncMode: "sidecar", syncPort: 8001 };
  }
  return d;
}

/**
 * Resolve the dev image from stacks' file/env pin and reject mutable/missing refs.
 * The registry owns the repository/build contract, never a second version pin.
 */
export function resolveDevPreviewImage(
  d: DevPreviewDescriptor,
  env: Record<string, string | undefined>,
): string {
  const image = resolveImagePin(d.imageEnvKey, env);
  if (!image) {
    throw new Error(
      `Missing required dev-preview image pin ${d.imageEnvKey} for ${d.service}`,
    );
  }
  return assertDevPreviewImage(d, image);
}

/** Validate explicit and persisted image selections against the same pin policy. */
export function assertDevPreviewImage(
  d: DevPreviewDescriptor,
  image: string,
): string {
  const expectedRepository = d.devBuild.image;
  if (
    !image.startsWith(`${expectedRepository}:`) &&
    !image.startsWith(`${expectedRepository}@`)
  ) {
    throw new Error(
      `Dev-preview image ${d.imageEnvKey} must use ${expectedRepository}`,
    );
  }
  if (
    !/@sha256:[0-9a-f]{64}$/i.test(image) &&
    !/:git-[0-9a-f]{40}$/i.test(image)
  ) {
    throw new Error(
      `Dev-preview image ${d.imageEnvKey} must be pinned by digest or full git SHA tag`,
    );
  }
  return image;
}

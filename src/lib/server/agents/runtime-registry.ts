/**
 * BFF reader for the declarative durable-agent runtime registry.
 *
 * Phase 2 of the DurableSessionRuntime standardization: the BFF now reads the
 * SAME registry the Python orchestrator does, instead of repeating the runtime
 * list across scattered enumerations (container allowlists, default-runtime
 * fallback, benchmark list, …).
 *
 * Data source: `./runtime-registry.data.json`, a build-context-local copy of the
 * canonical SSOT `services/shared/runtime-registry.json`, kept in sync by
 * `scripts/sync-runtime-registry.mjs` and guarded by a drift test
 * (`runtime-registry.drift.test.ts`). The copy exists because the BFF build
 * bundles `src/`, and the canonical lives outside it.
 */
import registryData from "./runtime-registry.data.json";

export type DurabilityGranularity = "per-activity" | "per-turn" | "per-session";

/**
 * Where a runtime's agent does filesystem I/O — the SHARING domain for multi-node
 * workflows. Two `durable/run` nodes can only share files (same `workspaceRef`) if
 * they have the SAME `workspaceBackend`:
 *  - `juicefs-shared`    — pod-local per-execution JuiceFS at /sandbox/work, keyed by
 *                          sharedWorkspaceKey (executionId). Interactive-cli family.
 *  - `openshell-shared`  — a remote OpenShell sandbox, keyed by sandboxName
 *                          (executionId-derived). dapr-agent-py / browser-use.
 *  - `pod-local`         — the agent's own pod filesystem; NOT shared across pods.
 *                          claude-agent-py / adk-agent-py.
 * These backends are physically distinct storage, so mixing them across phases of
 * one file-sharing workflow silently loses files — the resolver rejects it.
 */
export type WorkspaceBackend = "juicefs-shared" | "openshell-shared" | "pod-local";

export type RuntimeCapabilities = {
	durabilityGranularity: DurabilityGranularity;
	workspaceBackend: WorkspaceBackend;
	workflowDispatch?: "auto-turn" | "none";
	retryMaxAttempts: number;
	durableTurnTimer: boolean;
	supportsMcp: boolean;
	supportsSkills: boolean;
	supportsBuiltinOpenShellTools: boolean;
	supportsHooks: boolean;
	hookTiming: "live" | "batch";
	/**
	 * The runtime can be triggered by an event (Dapr pub/sub `agent.trigger`
	 * → BFF → `spawn.ts`). True for every dispatchable runtime (dispatch is
	 * BFF-side + runtime-agnostic). See `docs/event-driven-invocation-and-unified-hooks.md`.
	 */
	eventDrivenInvocation?: boolean;
	/**
	 * The runtime accepts idempotent team-mailbox batches and returns the exact
	 * delivery receipt before the BFF marks the source events processed.
	 */
	supportsTeamMailboxReceipts: boolean;
	/**
	 * The runtime honors a portable `agentConfig.hooks` block. dapr-agent-py
	 * runs them natively; the interactive-cli family executes them in cli-agent-py's
	 * HookProcessor. `false` where there is no hook execution surface (adk,
	 * claude-agent-py).
	 */
	portableHooks?: boolean;
	/**
	 * How strongly a hook can BLOCK a tool/turn: `full` (PreToolUse can deny —
	 * dapr-agent-py, claude-code-cli), `advisory` (hooks run but can't block —
	 * codex-cli, agy-cli), `none`. Swap-safety WARNs on full→advisory/none.
	 */
	hookBlockingGranularity?: "full" | "advisory" | "none";
	supportsPermissionGating: boolean;
	supportsPlugins: boolean;
	supportsCompaction: boolean;
	/** Final structured results can be submitted through the runtime's output tool. */
	structuredOutputMode?: "tool";
	/** JSON Schema dialect accepted by the structured-output validator. */
	structuredOutputJsonSchemaDraft?: "2020-12";
	/** Modalities accepted directly from a user turn by this runtime. */
	userInputModalities?: Array<"text" | "image" | "video">;
	/** Modalities a tool result can preserve as native model input. */
	toolResultModalities?: Array<"text" | "image" | "video">;
	/** The runtime exposes a confined ReadMediaFile image tool. */
	supportsReadMediaFile?: boolean;
	/** Binary media is kept out of durable workflow payloads. */
	supportsMediaExternalization?: boolean;
	/** How binary media is represented in durable workflow history. */
	durableMediaMode?: "content-addressed";
	incrementalEvents: boolean;
	ownsSandbox: boolean;
	requiresWarmPool: boolean;
	requiresBrowserSidecars: boolean;
	multiProvider: boolean;
	supportedProviders: string[];
	/**
	 * The runtime exposes the agent as an interactive TUI in the session's
	 * sandbox pod (web-terminal-first UX, lifecycle-wrapped workflow). Only
	 * `interactive-cli`-family runtimes set this.
	 */
	interactiveTerminal?: boolean;
};

/**
 * Per-user CLI credential contract for `interactive-cli` runtimes: which
 * provider token the user must enroll (Settings → CLI tokens) and how the
 * runtime consumes it. Consumed generically by the settings page and the
 * spawn-time readiness gate.
 */
export type RuntimeCliAuth = {
	provider: string;
	/**
	 * `subscription_oauth` — a personal subscription OAuth token (anthropic/openai/
	 * google CLIs; usage stays on the user's plan). `api_key` — a provider API key
	 * for an Anthropic-compatible GATEWAY (claude-code-cli-glm → Z.AI GLM Coding
	 * Plan): the token is the metered billing credential, delivered as
	 * `envVar`=ANTHROPIC_AUTH_TOKEN alongside `apiBaseUrl`. Distinct from the
	 * subscription CLIs' "never let a provider API key reach the pod" invariant —
	 * here there is no subscription to protect, so the key IS the intended auth.
	 */
	tokenKind: "subscription_oauth" | "api_key";
	/**
	 * How the OAuth credential reaches the pod + is consumed in-pod:
	 *  - `env_token`    — a single opaque token delivered as `envVar`, read
	 *                     directly by the CLI (Claude Code: CLAUDE_CODE_OAUTH_TOKEN).
	 *  - `file`         — a credential FILE blob delivered as `envVar`, written by
	 *                     the adapter's seed() to `credentialPath` (Codex: auth.json).
	 *  - `file_bundle`  — a base64 tar.gz of the CLI's whole login dir, delivered as
	 *                     `envVar`; the adapter's seed() restores it. OPTIONAL: if the
	 *                     user has none yet, the runtime falls back to in-terminal
	 *                     device-code login and AUTO-CAPTURES the dir afterward.
	 *                     (Antigravity: the ~/.gemini login files — agy is file-based,
	 *                     the OS-keyring path is vestigial. One login, then every
	 *                     future pod boots signed-in.)
	 *  - `device_login` — no pre-provisioned credential; the user completes an
	 *                     in-terminal device-code OAuth flow on first launch (no
	 *                     `envVar`), and nothing is captured/stored.
	 */
	credentialKind: "env_token" | "file" | "file_bundle" | "device_login";
	/** Settings-UI rendering hint for the enrollment instructions. */
	loginStyle?: "browser_token" | "auth_file" | "device_code" | "api_key";
	/** Delivery env var (env_token + file). Absent for device_login. */
	envVar?: string;
	/** In-pod path the file blob is materialized to (file kind only). */
	credentialPath?: string;
	/** Command the user runs locally to mint the credential (na for device_login). */
	setupCommand?: string;
	/**
	 * Anthropic-compatible GATEWAY base URL for `tokenKind: "api_key"` runtimes
	 * (claude-code-cli-glm → https://api.z.ai/api/anthropic). Injected per-session
	 * as ANTHROPIC_BASE_URL so the Claude Code CLI talks to the provider gateway
	 * instead of api.anthropic.com. Absent for subscription CLIs.
	 */
	apiBaseUrl?: string;
};

export type RuntimeDescriptor = {
	id: string;
	/**
	 * Session-hosting mode (concurrency plan P3). "shared-pool": sessions
	 * multiplex as workflow instances onto the standing pool Deployment for the
	 * runtime class (e.g. agent-runtime-pool-coding) instead of provisioning a
	 * per-session Kueue host — the Dapr workflow engine hash-spreads instances
	 * across pool replicas. Only valid for runtimes WITHOUT per-session secret
	 * env (no cliAuth): the pool has no per-session secret channel; session
	 * config rides childInput per dispatch. Absent / "per-session-pod" keeps the
	 * dedicated per-session host lane. Explicit runtimeIsolation="dedicated" and
	 * per-session secret env always override back to per-session-pod.
	 */
	hostMode?: "per-session-pod" | "shared-pool";
	appIdConfigKey: string;
	instancePrefix: string;
	family: "durable-session" | "browser" | "interactive-cli";
	mainContainerName: string;
	imageEnvKey: string | null;
	agentMetadataFramework: string;
	benchmarkEligible: boolean;
	capabilitiesVerified: boolean;
	/** sandbox-execution-api execution class override (else the BFF env default). */
	executionClass?: string;
	/**
	 * Adapter id the cli-agent-py host selects (stamped into agentConfig.cliAdapter
	 * at spawn). One image hosts all interactive-cli adapters; this picks which.
	 */
	cliAdapter?: string;
	cliAuth?: RuntimeCliAuth;
	/**
	 * Per-session, non-secret environment for gateway-backed CLI runtimes
	 * (claude-code-cli-glm): the Claude Code model-tier → provider-model mapping
	 * (ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL) + gateway knobs like
	 * CLAUDE_CODE_AUTO_COMPACT_WINDOW. Delivered alongside the credential via the
	 * per-session env channel (session-secret-env.ts). Absent for stock CLIs,
	 * which use Claude Code's baked-in Anthropic model defaults.
	 */
	cliModelEnv?: Record<string, string>;
	capabilities: RuntimeCapabilities;
};

const RUNTIMES = registryData.runtimes as RuntimeDescriptor[];
const BY_ID = new Map(RUNTIMES.map((d) => [d.id, d]));

/** The runtime used when none is specified (matches the orchestrator default). */
export const DEFAULT_RUNTIME_ID: string = registryData.defaultRuntimeId;
/** The Dapr workflow every durable-session runtime registers + is dispatched. */
export const DISPATCH_WORKFLOW_NAME: string = registryData.dispatchWorkflowName;

/**
 * Fixed, non-runtime container names that are also shell-able (the browser
 * sidecars). daprd is intentionally excluded — it is the Dapr sidecar, not
 * user-authored code.
 */
export const FIXED_SIDECAR_CONTAINERS = ["chromium", "playwright-mcp"] as const;

export function getRuntimeDescriptor(
	id: string | null | undefined
): RuntimeDescriptor | undefined {
	return id ? BY_ID.get(id) : undefined;
}

/**
 * The filesystem SHARING domain for a runtime (see {@link WorkspaceBackend}).
 * Unknown runtimes default to `pod-local` (the safe non-sharing assumption).
 */
export function workspaceBackendForRuntime(
	id: string | null | undefined,
): WorkspaceBackend {
	return getRuntimeDescriptor(id)?.capabilities.workspaceBackend ?? "pod-local";
}

export function listRuntimes(): readonly RuntimeDescriptor[] {
	return RUNTIMES;
}

/**
 * The cliAuth descriptor for a provider (anthropic | openai | google), used by
 * the credential store + settings UI to validate/render per credentialKind.
 * Returns the first interactive-cli runtime that declares this provider.
 */
export function cliAuthForProvider(
	provider: string
): RuntimeCliAuth | undefined {
	return RUNTIMES.find((d) => d.cliAuth?.provider === provider)?.cliAuth;
}

export function listRuntimeIds(): string[] {
	return RUNTIMES.map((d) => d.id);
}

/** Runtimes eligible for the SWE-bench benchmark runtime picker. */
export function listBenchmarkRuntimeIds(): string[] {
	return RUNTIMES.filter((d) => d.benchmarkEligible).map((d) => d.id);
}

/** Runtimes that can satisfy a SW 1.0 durable/run one-turn dispatch. */
export function listWorkflowDispatchRuntimeIds(): string[] {
	return RUNTIMES.filter((d) => d.capabilities.workflowDispatch === "auto-turn").map(
		(d) => d.id
	);
}

/**
 * Container names the shell/exec proxy permits: every runtime's main container
 * plus the fixed browser sidecars. Replaces the three hand-synced
 * `ALLOWED_CONTAINERS`/`SHELLABLE_CONTAINERS` sets.
 */
export function shellableContainers(): Set<string> {
	return new Set<string>([
		...RUNTIMES.map((d) => d.mainContainerName),
		...FIXED_SIDECAR_CONTAINERS
	]);
}

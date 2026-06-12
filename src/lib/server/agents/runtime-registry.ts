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

export type RuntimeCapabilities = {
	durabilityGranularity: DurabilityGranularity;
	retryMaxAttempts: number;
	durableTurnTimer: boolean;
	supportsMcp: boolean;
	supportsSkills: boolean;
	supportsBuiltinOpenShellTools: boolean;
	supportsHooks: boolean;
	hookTiming: "live" | "batch";
	supportsPermissionGating: boolean;
	supportsPlugins: boolean;
	supportsCompaction: boolean;
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
	tokenKind: "subscription_oauth";
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
	loginStyle?: "browser_token" | "auth_file" | "device_code";
	/** Delivery env var (env_token + file). Absent for device_login. */
	envVar?: string;
	/** In-pod path the file blob is materialized to (file kind only). */
	credentialPath?: string;
	/** Command the user runs locally to mint the credential (na for device_login). */
	setupCommand?: string;
};

export type RuntimeDescriptor = {
	id: string;
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

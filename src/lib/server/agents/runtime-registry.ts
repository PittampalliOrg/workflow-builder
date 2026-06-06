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

export type DurabilityGranularity = "per-activity" | "per-turn";

export type RuntimeCapabilities = {
	durabilityGranularity: DurabilityGranularity;
	retryMaxAttempts: number;
	durableTurnTimer: boolean;
	supportsMcp: boolean;
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
};

export type RuntimeDescriptor = {
	id: string;
	appIdConfigKey: string;
	instancePrefix: string;
	family: "durable-session" | "browser";
	mainContainerName: string;
	imageEnvKey: string | null;
	agentMetadataFramework: string;
	benchmarkEligible: boolean;
	capabilitiesVerified: boolean;
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

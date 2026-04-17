export type EnvironmentRuntime = "cloud";

export type EnvironmentNetworkingUnrestricted = {
	type: "unrestricted";
};

export type EnvironmentNetworkingAllowedHosts = {
	type: "allowed_hosts";
	allowedHosts: string[];
};

export type EnvironmentNetworking =
	| EnvironmentNetworkingUnrestricted
	| EnvironmentNetworkingAllowedHosts;

export type EnvironmentResourceLimits = {
	memoryMb?: number;
	cpuMillicores?: number;
	diskMb?: number;
};

/**
 * Sandbox provisioning mode. Replaces the old `SandboxPolicyMode` enum one-for-one.
 * Environments carry the mode as part of their config so an agent picks an
 * environment and gets the sandbox behavior baked in — no per-workflow overrides.
 */
export type EnvironmentSandboxMode =
	| "shared-runtime"
	| "per-run"
	| "per-node"
	| "provided";

export type EnvironmentConfig = {
	sandboxTemplate: string;
	sandboxMode: EnvironmentSandboxMode;
	keepAfterRun: boolean;
	ttlSeconds?: number;
	networking: EnvironmentNetworking;
	packages?: string[];
	resourceLimits?: EnvironmentResourceLimits;
};

export type EnvironmentRef = {
	id: string;
	version?: number;
};

export type EnvironmentSummary = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	avatar: string | null;
	tags: string[];
	runtime: EnvironmentRuntime;
	currentVersion: number | null;
	sandboxTemplate: string | null;
	networkingType: EnvironmentNetworking["type"] | null;
	usedByCount?: number;
	isArchived: boolean;
	createdAt: string;
	updatedAt: string;
};

export type EnvironmentDetail = EnvironmentSummary & {
	config: EnvironmentConfig;
};

export type EnvironmentVersionSummary = {
	id: string;
	environmentId: string;
	version: number;
	configHash: string;
	changelog: string | null;
	publishedAt: string | null;
	publishedBy: string | null;
	createdAt: string;
};

export const DEFAULT_SANDBOX_TEMPLATE = "dapr-agent";
export const XLSX_SANDBOX_TEMPLATE = "dapr-agent-xlsx";
export const DEFAULT_SANDBOX_TTL_SECONDS = 7200;

export function createDefaultEnvironmentConfig(): EnvironmentConfig {
	return {
		sandboxTemplate: DEFAULT_SANDBOX_TEMPLATE,
		sandboxMode: "per-run",
		keepAfterRun: false,
		ttlSeconds: DEFAULT_SANDBOX_TTL_SECONDS,
		networking: { type: "unrestricted" },
	};
}

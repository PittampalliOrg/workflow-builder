export type EnvironmentRuntime = "cloud";

export type EnvironmentNetworkingUnrestricted = {
	type: "unrestricted";
};

/**
 * CMA-parity "Limited" networking mode. Matches platform.claude.com's
 * environment editor: an allow-list of hosts plus two carve-out flags for
 * package-manager registries and MCP servers. We still accept the legacy
 * "allowed_hosts" type name on the read path for backward compatibility, but
 * writes must use "limited".
 */
export type EnvironmentNetworkingLimited = {
	type: "limited";
	allowedHosts?: string[];
	allowMcpServers?: boolean;
	allowPackageManagers?: boolean;
};

export type EnvironmentNetworking =
	| EnvironmentNetworkingUnrestricted
	| EnvironmentNetworkingLimited;

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

/**
 * Package manager namespaces CMA supports, in the install-order it documents:
 * apt → cargo → gem → go → npm → pip. Our sandbox init container runs them in
 * the same order for parity.
 */
export type PackageManager =
	| "apt"
	| "cargo"
	| "gem"
	| "go"
	| "npm"
	| "pip";

export const PACKAGE_MANAGERS: readonly PackageManager[] = [
	"apt",
	"cargo",
	"gem",
	"go",
	"npm",
	"pip",
] as const;

/**
 * One package to install inside the sandbox. `spec` is the native manager
 * syntax the packaged tool accepts — for pip/npm that's a name, optionally
 * pinned with `==` / `@`; for apt it's a package name.
 */
export type EnvironmentPackage = {
	manager: PackageManager;
	spec: string;
};

export type EnvironmentConfig = {
	sandboxTemplate: string;
	sandboxMode: EnvironmentSandboxMode;
	keepAfterRun: boolean;
	ttlSeconds?: number;
	networking: EnvironmentNetworking;
	/**
	 * CMA-shape package manifest. Legacy string[] data is migrated on read
	 * (assumed all pip) but writes must use the structured shape.
	 */
	packages?: EnvironmentPackage[];
	metadata?: Record<string, string>;
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

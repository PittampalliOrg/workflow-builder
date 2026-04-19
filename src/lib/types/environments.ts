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

export type EnvironmentConfig = {
	/**
	 * DEPRECATED — retained for rollback safety during the Profile→Env
	 * collapse. Reader code SHOULD ignore this; writer code MUST NOT set it.
	 * The environment's own slug is the template identifier going forward.
	 */
	sandboxTemplate?: string;
	sandboxMode: EnvironmentSandboxMode;
	keepAfterRun: boolean;
	ttlSeconds?: number;
	networking: EnvironmentNetworking;
	/**
	 * CMA-shape package manifest — {manager: [specs, ...]}. Installed via
	 * the Dockerfile generator at image-build time (not at sandbox create
	 * time) since OpenShell's runtime install path is unreliable.
	 */
	packages?: CmaPackages;
	/**
	 * Capability slugs surfaced to the sandbox-capability matcher. Informational;
	 * the sandbox image is the source of truth for what's actually available.
	 */
	capabilities?: string[];
	metadata?: Record<string, string>;
	resourceLimits?: EnvironmentResourceLimits;
};

/**
 * CMA-shape package manifest. Each key is a package-manager name; the value
 * is a list of specs in that manager's native syntax (pip: "pkg==1.0.0",
 * npm: "pkg@1.0.0", apt: package name, cargo: "pkg@1.0.0", gem: "pkg:1.0",
 * go: "module@ver"). Mirrors platform.claude.com environment.packages.
 */
export type CmaPackages = {
	apt?: string[];
	pip?: string[];
	npm?: string[];
	cargo?: string[];
	gem?: string[];
	go?: string[];
};

/**
 * Build artifacts live on the environment_version row (columns added in
 * migration 0038). Not part of the config JSONB — they're stamped by the
 * Tekton pipeline + admin-UI polling.
 */
export type EnvironmentBuildArtifacts = {
	imageTag: string | null;
	dockerfilePath: string | null;
	lastBuildSha: string | null;
	lastBuildAt: string | null;
	lastBuildStatus: "built" | "building" | "failed" | null;
	lastBuildError: string | null;
};

/**
 * Builtin env slugs seeded by the migration. Each maps 1:1 to a pre-built
 * image tag. Custom envs can inherit from these via `environments.base_env_slug`
 * (1-level inheritance only, enforced by the registry validator).
 */
export const BUILTIN_ENVIRONMENT_SLUGS = [
	"dapr-agent",
	"dapr-agent-xlsx",
	"dapr-agent-animation",
	"dapr-agent-datasci",
	"dapr-agent-webdev",
] as const;

export type BuiltinEnvironmentSlug = (typeof BUILTIN_ENVIRONMENT_SLUGS)[number];

/**
 * Env slugs are used as Docker image tag suffixes — lowercase alphanumerics +
 * dashes, no leading/trailing dash, no double dashes.
 */
export const ENVIRONMENT_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
	isBuiltin: boolean;
	baseEnvSlug: string | null;
	build: EnvironmentBuildArtifacts;
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

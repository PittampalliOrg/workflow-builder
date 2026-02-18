/**
 * Dapr Configuration and Secrets Provider
 *
 * Provides a unified interface for accessing configuration values and secrets
 * through Dapr's Configuration and Secrets building blocks.
 *
 * Features:
 * - Caches configuration and secrets at startup
 * - Requires Dapr secret stores for secret resolution (no env fallback)
 * - Type-safe access to known configuration keys
 *
 * @example
 * ```ts
 * // Initialize at startup
 * await initializeConfig();
 *
 * // Use throughout the application
 * const url = getOrchestratorUrl();
 * const apiKey = getSecretValue("OPENAI_API_KEY");
 * ```
 */

import {
	getConfiguration,
	getSecret,
	getSecretMap,
	isAvailable,
} from "./client";

// ============================================================================
// Configuration
// ============================================================================

/**
 * Dapr component names
 */
const CONFIG_STORE =
	process.env.DAPR_CONFIG_STORE || "azureappconfig-workflow-builder";
// Keep both env var names for compatibility across services.
const SECRET_STORE =
	process.env.DAPR_SECRET_STORE ||
	process.env.DAPR_SECRETS_STORE ||
	"azure-keyvault";
const CONFIG_LABEL = process.env.CONFIG_LABEL || "workflow-builder";
const K8S_SECRET_NAME =
	process.env.DAPR_K8S_SECRET_NAME || "workflow-builder-secrets";

/**
 * Configuration keys to load from Dapr Configuration store
 */
const CONFIG_KEYS = [
	// Service URLs
	"WORKFLOW_ORCHESTRATOR_URL",
	"GENERIC_ORCHESTRATOR_URL",
	"FUNCTION_RUNNER_URL",
	// Feature flags
	"USE_DAPR_SERVICE_INVOCATION",
	"DAPR_WORKFLOW_ENABLED",
	// Observability
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_SERVICE_NAME",
	// Auth
	"AUTH_TRUST_HOST",
	"AUTH_URL",
	"NEXT_PUBLIC_APP_URL",
] as const;

/**
 * Secret mappings from ENV_VAR to secret names in Dapr secret stores.
 * Canonical Key Vault names are listed first (e.g. OPENAI-API-KEY).
 */
const SECRET_MAPPINGS: Record<string, readonly string[]> = {
	DATABASE_URL: ["WORKFLOW-BUILDER-DATABASE-URL", "DATABASE_URL"],
	BETTER_AUTH_SECRET: ["WORKFLOW-BUILDER-AUTH-SECRET", "BETTER_AUTH_SECRET"],
	INTEGRATION_ENCRYPTION_KEY: [
		"WORKFLOW-BUILDER-INTEGRATION-KEY",
		"INTEGRATION_ENCRYPTION_KEY",
	],
	JWT_SIGNING_KEY: ["WORKFLOW-BUILDER-JWT-SIGNING-KEY", "JWT_SIGNING_KEY"],
	OPENAI_API_KEY: ["OPENAI-API-KEY", "OPENAI_API_KEY"],
	ANTHROPIC_API_KEY: ["ANTHROPIC-API-KEY", "ANTHROPIC_API_KEY"],
	AI_GATEWAY_API_KEY: ["OPENAI-API-KEY", "AI_GATEWAY_API_KEY"],
	GITHUB_TOKEN: ["GITHUB-TOKEN", "GITHUB_TOKEN"],
};

/**
 * Keys expected to exist in the workflow-builder-secrets Kubernetes Secret.
 * When using the Dapr Kubernetes secret store, we read a single secret and
 * extract these keys from its returned map.
 */
const K8S_SECRET_KEYS = [
	"DATABASE_URL",
	"AP_ENCRYPTION_KEY",
	"INTERNAL_API_TOKEN",
	"JWT_SIGNING_KEY",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"AI_GATEWAY_API_KEY",
	"GITHUB_CLIENT_ID",
	"GITHUB_CLIENT_SECRET",
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
	"OAUTH_APP_GOOGLE_CLIENT_ID",
	"OAUTH_APP_GOOGLE_CLIENT_SECRET",
	"OAUTH_APP_MICROSOFT_CLIENT_ID",
	"OAUTH_APP_MICROSOFT_CLIENT_SECRET",
	"OAUTH_APP_LINKEDIN_CLIENT_ID",
	"OAUTH_APP_LINKEDIN_CLIENT_SECRET",
] as const;

const REQUIRED_SECRET_KEYS = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"AI_GATEWAY_API_KEY",
] as const;

// ============================================================================
// State
// ============================================================================

const configCache: Record<string, string> = {};
const secretCache: Record<string, string> = {};
let initialized = false;
let initializationPromise: Promise<void> | null = null;
let daprAvailable = false;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the configuration and secrets provider
 * Should be called during application startup
 */
export async function initializeConfig(): Promise<void> {
	if (initialized) {
		return;
	}
	if (initializationPromise) {
		return initializationPromise;
	}

	initializationPromise = doInitialize();
	return initializationPromise;
}

async function doInitialize(): Promise<void> {
	console.log("[ConfigProvider] Initializing configuration...");

	try {
		daprAvailable = await isAvailable();
	} catch {
		daprAvailable = false;
	}

	if (!daprAvailable) {
		throw new Error(
			"[ConfigProvider] Dapr sidecar not available. Secret fallback is disabled.",
		);
	}

	console.log(
		"[ConfigProvider] Dapr sidecar available, loading from Dapr stores...",
	);

	// Load configuration from Dapr
	try {
		await loadConfigurationFromDapr();
	} catch (error) {
		console.warn(
			"[ConfigProvider] Failed to load configuration from Dapr:",
			error,
		);
		loadConfigFromEnvironment();
	}

	// Load secrets from Dapr
	try {
		await loadSecretsFromDapr();
	} catch (error) {
		console.error("[ConfigProvider] Failed to load secrets from Dapr:", error);
		throw error;
	}

	initialized = true;
	console.log("[ConfigProvider] Initialization complete");
}

async function loadConfigurationFromDapr(): Promise<void> {
	const stores =
		CONFIG_STORE === "azureappconfig"
			? ["azureappconfig"]
			: [CONFIG_STORE, "azureappconfig"];

	const missingKeys: string[] = [];

	for (const key of CONFIG_KEYS) {
		let resolved: string | null = null;

		for (const storeName of stores) {
			try {
				const config = await getConfiguration(storeName, [key], {
					label: CONFIG_LABEL,
				});
				const item = config[key];
				if (item?.value !== undefined) {
					resolved = item.value;
					break;
				}
			} catch {
				// Continue to the next configured store; missing keys are expected.
			}
		}

		if (resolved !== null) {
			configCache[key] = resolved;
			continue;
		}

		const envValue = process.env[key];
		if (envValue !== undefined) {
			configCache[key] = envValue;
			continue;
		}

		missingKeys.push(key);
	}

	console.log(
		`[ConfigProvider] Loaded ${Object.keys(configCache).length} configuration values`,
	);
	if (missingKeys.length > 0) {
		console.log(
			`[ConfigProvider] Missing ${missingKeys.length} config keys in Dapr/env: ${missingKeys.join(", ")}`,
		);
	}
}

async function loadSecretsFromDapr(): Promise<void> {
	const stores = getSecretStoreCandidates();
	for (const storeName of stores) {
		if (storeName === "kubernetes-secrets") {
			await loadSecretsFromKubernetesStore(storeName);
			continue;
		}
		await loadMappedSecretsFromStore(storeName);
	}

	const missingRequiredKeys = REQUIRED_SECRET_KEYS.filter(
		(key) => !secretCache[key],
	);
	if (missingRequiredKeys.length > 0) {
		throw new Error(
			`[ConfigProvider] Missing required secrets after Dapr resolution: ${missingRequiredKeys.join(", ")}`,
		);
	}

	console.log(
		`[ConfigProvider] Loaded ${Object.keys(secretCache).length} secrets`,
	);
}

function getSecretStoreCandidates(): string[] {
	const candidates = [
		process.env.DAPR_SECRETS_STORE,
		"azure-keyvault",
		SECRET_STORE,
		process.env.DAPR_SECRET_STORE,
		"kubernetes-secrets",
	].filter((name): name is string => Boolean(name && name.trim()));

	return Array.from(new Set(candidates));
}

async function loadSecretsFromKubernetesStore(
	storeName: string,
): Promise<void> {
	try {
		const data = await getSecretMap(storeName, K8S_SECRET_NAME);

		// Load mapped keys first so canonical names (OPENAI-API-KEY, etc.)
		// populate normalized env keys.
		for (const [envKey, secretNames] of Object.entries(SECRET_MAPPINGS)) {
			if (secretCache[envKey]) {
				continue;
			}
			const candidates = [...secretNames, envKey];
			for (const candidateKey of candidates) {
				const value = data[candidateKey];
				if (value !== undefined && value !== "") {
					secretCache[envKey] = value;
					break;
				}
			}
		}

		// Also hydrate direct keys from the Kubernetes secret map.
		for (const key of K8S_SECRET_KEYS) {
			if (secretCache[key]) {
				continue;
			}
			const value = data[key];
			if (value !== undefined && value !== "") {
				secretCache[key] = value;
			}
		}
	} catch (error) {
		console.warn(
			`[ConfigProvider] Failed loading secrets from ${storeName}:${K8S_SECRET_NAME}`,
			error,
		);
	}
}

async function loadMappedSecretsFromStore(storeName: string): Promise<void> {
	for (const [envKey, secretNames] of Object.entries(SECRET_MAPPINGS)) {
		if (secretCache[envKey]) {
			continue;
		}
		for (const secretName of secretNames) {
			try {
				const value = await getSecret(storeName, secretName);
				if (value) {
					secretCache[envKey] = value;
					break;
				}
			} catch {
				// Try the next candidate secret name/store.
			}
		}
	}
}

function loadConfigFromEnvironment(): void {
	for (const key of CONFIG_KEYS) {
		const value = process.env[key];
		if (value !== undefined) {
			configCache[key] = value;
		}
	}
}

// ============================================================================
// Accessors
// ============================================================================

/**
 * Get a configuration value
 */
export function getConfig(key: string, defaultValue?: string): string {
	if (key in configCache) {
		return configCache[key];
	}

	const envValue = process.env[key];
	if (envValue !== undefined) {
		return envValue;
	}

	return defaultValue ?? "";
}

/**
 * Get a secret value
 */
export function getSecretValue(key: string): string {
	if (key in secretCache) {
		return secretCache[key];
	}
	throw new Error(`[ConfigProvider] Secret not loaded: ${key}`);
}

/**
 * Check if a feature flag is enabled
 */
export function isFeatureEnabled(key: string): boolean {
	const value = getConfig(key, "false");
	return value === "true" || value === "1";
}

/**
 * Check if Dapr is being used
 */
export function isDaprEnabled(): boolean {
	return daprAvailable && initialized;
}

// ============================================================================
// Service URL Accessors
// ============================================================================

/**
 * Default URLs when Dapr config is not available
 */
const DEFAULT_ORCHESTRATOR_URL =
	"http://workflow-orchestrator.workflow-builder.svc.cluster.local:8080";
const DEFAULT_FUNCTION_RUNNER_URL =
	"http://function-runner.workflow-builder.svc.cluster.local:8080";

/**
 * Get the workflow orchestrator URL
 */
export function getOrchestratorUrl(): string {
	return getConfig("WORKFLOW_ORCHESTRATOR_URL", DEFAULT_ORCHESTRATOR_URL);
}

/**
 * Get the generic orchestrator URL (alias)
 */
export function getGenericOrchestratorUrl(): string {
	return getConfig("GENERIC_ORCHESTRATOR_URL", DEFAULT_ORCHESTRATOR_URL);
}

/**
 * Get the function runner URL
 */
export function getFunctionRunnerUrl(): string {
	return getConfig("FUNCTION_RUNNER_URL", DEFAULT_FUNCTION_RUNNER_URL);
}

// ============================================================================
// Async Accessors (for lazy initialization)
// ============================================================================

/**
 * Get orchestrator URL with lazy initialization
 */
export async function getOrchestratorUrlAsync(): Promise<string> {
	if (!initialized) {
		await initializeConfig();
	}
	return getOrchestratorUrl();
}

/**
 * Get a configuration value with lazy initialization
 */
export async function getConfigAsync(
	key: string,
	defaultValue?: string,
): Promise<string> {
	if (!initialized) {
		await initializeConfig();
	}
	return getConfig(key, defaultValue);
}

/**
 * Get a secret value with lazy initialization
 */
export async function getSecretValueAsync(key: string): Promise<string> {
	if (!initialized) {
		await initializeConfig();
	}
	return getSecretValue(key);
}

/**
 * Dapr Configuration and Secrets Provider
 *
 * Provides a unified interface for accessing configuration values and secrets
 * through Dapr's Configuration and Secrets building blocks.
 *
 * Features:
 * - Caches configuration and secrets at startup
 * - Falls back to environment variables when Dapr is unavailable
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
const SECRET_STORE = process.env.DAPR_SECRET_STORE || "kubernetes-secrets";
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
  "DAPR_ORCHESTRATOR_URL",
  "ACTIVITY_EXECUTOR_URL",
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
 * Secret mappings from ENV_VAR to Azure Key Vault secret name
 */
const SECRET_MAPPINGS: Record<string, string> = {
  DATABASE_URL: "WORKFLOW-BUILDER-DATABASE-URL",
  BETTER_AUTH_SECRET: "WORKFLOW-BUILDER-AUTH-SECRET",
  INTEGRATION_ENCRYPTION_KEY: "WORKFLOW-BUILDER-INTEGRATION-KEY",
  OPENAI_API_KEY: "OPENAI-API-KEY",
  ANTHROPIC_API_KEY: "ANTHROPIC-API-KEY",
  GITHUB_TOKEN: "GITHUB-TOKEN",
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
    console.log(
      "[ConfigProvider] Dapr sidecar not available, using environment variables"
    );
    loadFromEnvironment();
    initialized = true;
    return;
  }

  console.log(
    "[ConfigProvider] Dapr sidecar available, loading from Dapr stores..."
  );

  // Load configuration from Dapr
  try {
    await loadConfigurationFromDapr();
  } catch (error) {
    console.warn(
      "[ConfigProvider] Failed to load configuration from Dapr:",
      error
    );
    loadConfigFromEnvironment();
  }

  // Load secrets from Dapr
  try {
    await loadSecretsFromDapr();
  } catch (error) {
    console.warn("[ConfigProvider] Failed to load secrets from Dapr:", error);
    loadSecretsFromEnvironment();
  }

  initialized = true;
  console.log("[ConfigProvider] Initialization complete");
}

async function loadConfigurationFromDapr(): Promise<void> {
  const mutableKeys = [...CONFIG_KEYS];
  const config = await getConfiguration(CONFIG_STORE, mutableKeys, {
    label: CONFIG_LABEL,
  });

  for (const key of CONFIG_KEYS) {
    const item = config[key];
    if (item?.value !== undefined) {
      configCache[key] = item.value;
    } else {
      // Fall back to environment variable
      const envValue = process.env[key];
      if (envValue !== undefined) {
        configCache[key] = envValue;
      }
    }
  }

  console.log(
    `[ConfigProvider] Loaded ${Object.keys(configCache).length} configuration values`
  );
}

async function loadSecretsFromDapr(): Promise<void> {
  // Prefer Kubernetes secret store when configured (single Secret with multiple keys).
  if (SECRET_STORE === "kubernetes-secrets") {
    const data = await getSecretMap(SECRET_STORE, K8S_SECRET_NAME);
    for (const key of K8S_SECRET_KEYS) {
      const value = data[key];
      if (value !== undefined && value !== "") {
        secretCache[key] = value;
        continue;
      }
      const envValue = process.env[key];
      if (envValue !== undefined) {
        secretCache[key] = envValue;
      }
    }

    console.log(
      `[ConfigProvider] Loaded ${Object.keys(secretCache).length} secrets from ${SECRET_STORE}:${K8S_SECRET_NAME}`
    );
    return;
  }

  // Azure Key Vault / single-value stores (secret name == key).
  for (const [envKey, kvName] of Object.entries(SECRET_MAPPINGS)) {
    try {
      const value = await getSecret(SECRET_STORE, kvName);
      if (value) {
        secretCache[envKey] = value;
      }
    } catch {
      const envValue = process.env[envKey];
      if (envValue !== undefined) {
        secretCache[envKey] = envValue;
      }
    }
  }

  console.log(
    `[ConfigProvider] Loaded ${Object.keys(secretCache).length} secrets`
  );
}

function loadFromEnvironment(): void {
  loadConfigFromEnvironment();
  loadSecretsFromEnvironment();
}

function loadConfigFromEnvironment(): void {
  for (const key of CONFIG_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      configCache[key] = value;
    }
  }
}

function loadSecretsFromEnvironment(): void {
  for (const envKey of Object.keys(SECRET_MAPPINGS)) {
    const value = process.env[envKey];
    if (value !== undefined) {
      secretCache[envKey] = value;
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

  const envValue = process.env[key];
  if (envValue !== undefined) {
    return envValue;
  }

  return "";
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
 * Get the legacy Dapr orchestrator URL
 */
export function getDaprOrchestratorUrl(): string {
  return getConfig("DAPR_ORCHESTRATOR_URL", DEFAULT_ORCHESTRATOR_URL);
}

/**
 * Get the function runner URL
 */
export function getFunctionRunnerUrl(): string {
  return getConfig("FUNCTION_RUNNER_URL", DEFAULT_FUNCTION_RUNNER_URL);
}

/**
 * Get the activity executor URL (legacy)
 */
export function getActivityExecutorUrl(): string {
  return getConfig("ACTIVITY_EXECUTOR_URL", DEFAULT_FUNCTION_RUNNER_URL);
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
  defaultValue?: string
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

/**
 * Configuration Service for Next.js App
 *
 * Fetches configuration directly from Dapr Configuration Store (Azure App Configuration)
 * via the local Dapr sidecar, with fallback to environment variables and defaults.
 *
 * Configuration values are cached locally and refreshed periodically.
 */

import "server-only";

import { getConfiguration, isAvailable } from "./dapr/client";

// Cache configuration
const configCache = new Map<string, { value: string; fetchedAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute cache

// Configuration keys for workflow builder
const CONFIG_KEYS = {
  WORKFLOW_ORCHESTRATOR_URL: "workflow-orchestrator-url",
  GENERIC_ORCHESTRATOR_URL: "generic-orchestrator-url",
} as const;

// Default values (fallback when config not available)
// All workflow services are in the workflow-builder namespace
const DEFAULTS: Record<string, string> = {
  [CONFIG_KEYS.WORKFLOW_ORCHESTRATOR_URL]: "http://workflow-orchestrator:8080",
  [CONFIG_KEYS.GENERIC_ORCHESTRATOR_URL]: "http://workflow-orchestrator:8080",
};

// Environment variable mappings
const ENV_MAPPINGS: Record<string, string> = {
  [CONFIG_KEYS.WORKFLOW_ORCHESTRATOR_URL]: "WORKFLOW_ORCHESTRATOR_URL",
  [CONFIG_KEYS.GENERIC_ORCHESTRATOR_URL]: "GENERIC_ORCHESTRATOR_URL",
};

/**
 * Dapr configuration store settings.
 *
 * Default store is workflow-builder scoped; falls back to "azureappconfig" if the
 * scoped component is not installed.
 */
const DAPR_CONFIG_STORE =
  process.env.DAPR_CONFIG_STORE || "azureappconfig-workflow-builder";
const DAPR_CONFIG_LABEL = process.env.CONFIG_LABEL || "workflow-builder";

/**
 * Cache Dapr health checks to avoid spamming the sidecar on every cache miss.
 */
let daprHealth: { ok: boolean; checkedAt: number } | null = null;
const DAPR_HEALTH_TTL_MS = 15_000;

async function isDaprAvailableCached(): Promise<boolean> {
  if (daprHealth && Date.now() - daprHealth.checkedAt < DAPR_HEALTH_TTL_MS) {
    return daprHealth.ok;
  }
  const ok = await isAvailable();
  daprHealth = { ok, checkedAt: Date.now() };
  return ok;
}

async function fetchConfigFromDapr(key: string): Promise<string | null> {
  if (!(await isDaprAvailableCached())) {
    return null;
  }

  const stores =
    DAPR_CONFIG_STORE === "azureappconfig"
      ? ["azureappconfig"]
      : [DAPR_CONFIG_STORE, "azureappconfig"];

  for (const storeName of stores) {
    try {
      const cfg = await getConfiguration(storeName, [key], {
        label: DAPR_CONFIG_LABEL,
      });
      const item = cfg[key];
      if (item?.value !== undefined) {
        return item.value;
      }
    } catch {
      // Try next store.
    }
  }

  return null;
}

/**
 * Get a configuration value with caching
 * Priority: Cache -> Dapr Config -> Environment Variable -> Default
 */
export async function getConfig(key: string): Promise<string> {
  // Check cache first
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  // Try to fetch from Dapr config store
  const daprValue = await fetchConfigFromDapr(key);
  if (daprValue !== null) {
    configCache.set(key, { value: daprValue, fetchedAt: Date.now() });
    return daprValue;
  }

  // Fall back to environment variable
  const envKey = ENV_MAPPINGS[key];
  const envValue = envKey ? process.env[envKey] : undefined;
  if (envValue) {
    configCache.set(key, { value: envValue, fetchedAt: Date.now() });
    return envValue;
  }

  // Fall back to default
  const defaultValue = DEFAULTS[key] || "";
  if (defaultValue) {
    configCache.set(key, { value: defaultValue, fetchedAt: Date.now() });
  }
  return defaultValue;
}

/**
 * Get the workflow orchestrator URL
 */
export async function getWorkflowOrchestratorUrl(): Promise<string> {
  return getConfig(CONFIG_KEYS.WORKFLOW_ORCHESTRATOR_URL);
}

/**
 * Get the generic orchestrator URL
 */
export async function getGenericOrchestratorUrl(): Promise<string> {
  return getConfig(CONFIG_KEYS.GENERIC_ORCHESTRATOR_URL);
}

/**
 * Exported config keys for type safety
 */
export { CONFIG_KEYS };

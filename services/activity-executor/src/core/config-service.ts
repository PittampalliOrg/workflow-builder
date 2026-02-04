/**
 * Configuration Service
 *
 * Fetches configuration from Dapr Configuration Store (Azure App Configuration).
 * Uses the Dapr HTTP API for configuration access.
 *
 * Configuration values are cached locally and refreshed periodically.
 */

const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";
const CONFIG_STORE = process.env.DAPR_CONFIG_STORE || "azureappconfig";

// Configuration cache
const configCache = new Map<string, { value: string; fetchedAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute cache

// Label to filter configuration values (must match Component spec)
const CONFIG_LABEL = process.env.CONFIG_LABEL || "activity-executor";

// All configurations cache (fetched once, filtered by label)
let allConfigsCache: { data: Record<string, string>; fetchedAt: number } | null = null;

/**
 * Fetch all configurations from Dapr configuration store
 * Filters by label metadata since the Dapr API doesn't filter server-side
 */
async function fetchAllConfigs(): Promise<Record<string, string>> {
  // Check cache
  if (allConfigsCache && Date.now() - allConfigsCache.fetchedAt < CACHE_TTL_MS) {
    return allConfigsCache.data;
  }

  try {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/configuration/${CONFIG_STORE}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.warn(`[Config Service] Failed to fetch all configs: ${response.status}`);
      return allConfigsCache?.data || {};
    }

    const data = await response.json() as Record<string, { value: string; metadata?: { label?: string } }>;

    // Filter by label and extract values
    const filtered: Record<string, string> = {};
    for (const [key, config] of Object.entries(data)) {
      if (config.metadata?.label === CONFIG_LABEL) {
        filtered[key] = config.value;
        configCache.set(key, { value: config.value, fetchedAt: Date.now() });
      }
    }

    allConfigsCache = { data: filtered, fetchedAt: Date.now() };
    console.log(`[Config Service] Loaded ${Object.keys(filtered).length} configs with label '${CONFIG_LABEL}'`);
    return filtered;
  } catch (error) {
    console.warn(`[Config Service] Dapr config store not available: ${error instanceof Error ? error.message : error}`);
    return allConfigsCache?.data || {};
  }
}

/**
 * Fetch a single configuration value from Dapr configuration store
 */
export async function getConfig(key: string, defaultValue?: string): Promise<string | undefined> {
  // Check cache first
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  // Fetch all configs (cached) and return the specific key
  const allConfigs = await fetchAllConfigs();
  return allConfigs[key] ?? defaultValue;
}

/**
 * Fetch multiple configuration values at once
 */
export async function getConfigs(keys: string[]): Promise<Record<string, string | undefined>> {
  const allConfigs = await fetchAllConfigs();
  const result: Record<string, string | undefined> = {};

  for (const key of keys) {
    result[key] = allConfigs[key];
  }

  return result;
}

/**
 * Get configuration as number
 */
export async function getConfigNumber(key: string, defaultValue: number): Promise<number> {
  const value = await getConfig(key);
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get configuration as boolean
 */
export async function getConfigBoolean(key: string, defaultValue: boolean): Promise<boolean> {
  const value = await getConfig(key);
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === "true" || value === "1";
}

/**
 * Activity executor configuration
 */
export interface ActivityExecutorConfig {
  logLevel: string;
  maxConcurrentActivities: number;
  activityTimeoutSeconds: number;
  retryMaxAttempts: number;
  retryDelaySeconds: number;
  openai: {
    defaultModel: string;
    maxTokens: number;
  };
  features: {
    daprSecretsEnabled: boolean;
    databaseFallback: boolean;
    otelTracing: boolean;
  };
}

/**
 * Load all activity executor configuration
 */
export async function loadActivityExecutorConfig(): Promise<ActivityExecutorConfig> {
  const keys = [
    "log-level",
    "max-concurrent-activities",
    "activity-timeout-seconds",
    "retry-max-attempts",
    "retry-delay-seconds",
    "openai/default-model",
    "openai/max-tokens",
    "features/dapr-secrets-enabled",
    "features/database-fallback",
    "features/otel-tracing",
  ];

  const configs = await getConfigs(keys);

  return {
    logLevel: configs["log-level"] || process.env.LOG_LEVEL || "info",
    maxConcurrentActivities: Number.parseInt(configs["max-concurrent-activities"] || "10", 10),
    activityTimeoutSeconds: Number.parseInt(configs["activity-timeout-seconds"] || "300", 10),
    retryMaxAttempts: Number.parseInt(configs["retry-max-attempts"] || "3", 10),
    retryDelaySeconds: Number.parseInt(configs["retry-delay-seconds"] || "5", 10),
    openai: {
      defaultModel: configs["openai/default-model"] || "gpt-4o",
      maxTokens: Number.parseInt(configs["openai/max-tokens"] || "4096", 10),
    },
    features: {
      daprSecretsEnabled: (configs["features/dapr-secrets-enabled"] || "true").toLowerCase() === "true",
      databaseFallback: (configs["features/database-fallback"] || "true").toLowerCase() === "true",
      otelTracing: (configs["features/otel-tracing"] || "true").toLowerCase() === "true",
    },
  };
}

/**
 * Subscribe to configuration changes (long-polling)
 * Note: Azure App Config Dapr component supports subscribePollingInterval
 */
export async function subscribeToConfigChanges(
  keys: string[],
  callback: (updates: Record<string, string>) => void
): Promise<() => void> {
  let running = true;

  const poll = async () => {
    while (running) {
      try {
        const keysParam = keys.map(k => `key=${encodeURIComponent(k)}`).join("&");
        const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0-alpha1/configuration/${CONFIG_STORE}/subscribe?${keysParam}`;

        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json() as { items: Record<string, { value: string }> };
          if (data.items && Object.keys(data.items).length > 0) {
            const updates: Record<string, string> = {};
            for (const [key, config] of Object.entries(data.items)) {
              updates[key] = config.value;
              configCache.set(key, { value: config.value, fetchedAt: Date.now() });
            }
            callback(updates);
          }
        }
      } catch (error) {
        // Subscription not supported or failed, fall back to polling
        await new Promise(resolve => setTimeout(resolve, 30_000));
      }
    }
  };

  // Start polling in background
  poll();

  // Return unsubscribe function
  return () => {
    running = false;
  };
}

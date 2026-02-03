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

/**
 * Fetch a single configuration value from Dapr configuration store
 */
export async function getConfig(key: string, defaultValue?: string): Promise<string | undefined> {
  // Check cache first
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/configuration/${CONFIG_STORE}?key=${encodeURIComponent(key)}`;
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        console.log(`[Config Service] Key not found: ${key}, using default`);
        return defaultValue;
      }
      console.warn(`[Config Service] Failed to fetch config ${key}: ${response.status}`);
      return defaultValue;
    }

    const data = await response.json() as Record<string, { value: string }>;

    if (data[key]?.value) {
      const value = data[key].value;
      configCache.set(key, { value, fetchedAt: Date.now() });
      console.log(`[Config Service] Loaded config: ${key}`);
      return value;
    }

    return defaultValue;
  } catch (error) {
    console.warn(`[Config Service] Dapr config store not available: ${error instanceof Error ? error.message : error}`);
    return defaultValue;
  }
}

/**
 * Fetch multiple configuration values at once
 */
export async function getConfigs(keys: string[]): Promise<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {};

  // Check which keys need fetching
  const keysToFetch: string[] = [];
  for (const key of keys) {
    const cached = configCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      result[key] = cached.value;
    } else {
      keysToFetch.push(key);
    }
  }

  if (keysToFetch.length === 0) {
    return result;
  }

  try {
    const keysParam = keysToFetch.map(k => `key=${encodeURIComponent(k)}`).join("&");
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/configuration/${CONFIG_STORE}?${keysParam}`;
    const response = await fetch(url);

    if (!response.ok) {
      console.warn(`[Config Service] Failed to fetch configs: ${response.status}`);
      return result;
    }

    const data = await response.json() as Record<string, { value: string }>;

    for (const [key, config] of Object.entries(data)) {
      if (config?.value) {
        result[key] = config.value;
        configCache.set(key, { value: config.value, fetchedAt: Date.now() });
      }
    }

    console.log(`[Config Service] Loaded ${Object.keys(data).length} configs`);
  } catch (error) {
    console.warn(`[Config Service] Dapr config store not available: ${error instanceof Error ? error.message : error}`);
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
  aiGateway: {
    defaultModel: string;
    defaultProvider: string;
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
    "ai-gateway/default-model",
    "ai-gateway/default-provider",
    "ai-gateway/max-tokens",
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
    aiGateway: {
      defaultModel: configs["ai-gateway/default-model"] || "gpt-4o",
      defaultProvider: configs["ai-gateway/default-provider"] || "openai",
      maxTokens: Number.parseInt(configs["ai-gateway/max-tokens"] || "4096", 10),
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

/**
 * Configuration Service for Next.js App
 *
 * Fetches configuration from the workflow-orchestrator service which has access
 * to Dapr Configuration Store (Azure App Configuration).
 *
 * Since the Next.js app doesn't have a Dapr sidecar, we fetch config via HTTP
 * from the orchestrator's /config endpoint, with fallback to environment variables.
 *
 * Configuration values are cached locally and refreshed periodically.
 */

// Cache configuration
const configCache = new Map<string, { value: string; fetchedAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute cache

// Configuration keys for workflow builder
const CONFIG_KEYS = {
  WORKFLOW_ORCHESTRATOR_URL: "workflow-orchestrator-url",
  DAPR_ORCHESTRATOR_URL: "dapr-orchestrator-url",
  ACTIVITY_EXECUTOR_URL: "activity-executor-url",
  GENERIC_ORCHESTRATOR_URL: "generic-orchestrator-url",
} as const;

// Default values (fallback when config not available)
// Use full FQDN since services are in different namespaces
const DEFAULTS: Record<string, string> = {
  [CONFIG_KEYS.WORKFLOW_ORCHESTRATOR_URL]: "http://workflow-orchestrator.workflow-orchestrator.svc.cluster.local:8080",
  [CONFIG_KEYS.DAPR_ORCHESTRATOR_URL]: "http://workflow-orchestrator.workflow-orchestrator.svc.cluster.local:8080",
  [CONFIG_KEYS.ACTIVITY_EXECUTOR_URL]: "http://activity-executor.activity-executor.svc.cluster.local:8080",
  [CONFIG_KEYS.GENERIC_ORCHESTRATOR_URL]: "http://workflow-orchestrator.workflow-orchestrator.svc.cluster.local:8080",
};

// Environment variable mappings
const ENV_MAPPINGS: Record<string, string> = {
  [CONFIG_KEYS.WORKFLOW_ORCHESTRATOR_URL]: "WORKFLOW_ORCHESTRATOR_URL",
  [CONFIG_KEYS.DAPR_ORCHESTRATOR_URL]: "DAPR_ORCHESTRATOR_URL",
  [CONFIG_KEYS.ACTIVITY_EXECUTOR_URL]: "ACTIVITY_EXECUTOR_URL",
  [CONFIG_KEYS.GENERIC_ORCHESTRATOR_URL]: "GENERIC_ORCHESTRATOR_URL",
};

/**
 * Get the orchestrator base URL for fetching config
 * Uses the correct cross-namespace FQDN.
 * Note: We use the hardcoded default instead of env vars because DevSpace
 * may override env vars with incorrect values until it's restarted.
 */
function getOrchestratorBaseUrl(): string {
  // Always use the correct FQDN for cross-namespace access
  // Env vars are not reliable during DevSpace development as they may have stale values
  return DEFAULTS[CONFIG_KEYS.WORKFLOW_ORCHESTRATOR_URL];
}

/**
 * Fetch configuration from the orchestrator's config endpoint
 */
async function fetchConfigFromOrchestrator(key: string): Promise<string | null> {
  try {
    const baseUrl = getOrchestratorBaseUrl();
    const url = `${baseUrl}/api/config/${encodeURIComponent(key)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      // Short timeout to avoid blocking
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as { value?: string };
    return data.value || null;
  } catch (error) {
    // Orchestrator config endpoint not available, will use fallback
    return null;
  }
}

/**
 * Get a configuration value with caching
 * Priority: Cache -> Orchestrator Config -> Environment Variable -> Default
 */
export async function getConfig(key: string): Promise<string> {
  // Check cache first
  const cached = configCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  // Try to fetch from orchestrator
  const orchestratorValue = await fetchConfigFromOrchestrator(key);
  if (orchestratorValue) {
    configCache.set(key, { value: orchestratorValue, fetchedAt: Date.now() });
    return orchestratorValue;
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
 * Get the workflow orchestrator URL (for generic TypeScript workflows)
 * Uses hardcoded default to avoid stale env var issues during DevSpace development.
 */
export async function getWorkflowOrchestratorUrl(): Promise<string> {
  return DEFAULTS[CONFIG_KEYS.WORKFLOW_ORCHESTRATOR_URL];
}

/**
 * Get the Dapr orchestrator URL (legacy planner workflows)
 * Uses hardcoded default to avoid stale env var issues during DevSpace development.
 */
export async function getDaprOrchestratorUrl(): Promise<string> {
  return DEFAULTS[CONFIG_KEYS.DAPR_ORCHESTRATOR_URL];
}

/**
 * Get the activity executor URL
 */
export async function getActivityExecutorUrl(): Promise<string> {
  return getConfig(CONFIG_KEYS.ACTIVITY_EXECUTOR_URL);
}

/**
 * Get the generic orchestrator URL
 * Uses hardcoded default to avoid stale env var issues during DevSpace development.
 */
export async function getGenericOrchestratorUrl(): Promise<string> {
  return DEFAULTS[CONFIG_KEYS.GENERIC_ORCHESTRATOR_URL];
}

/**
 * Exported config keys for type safety
 */
export { CONFIG_KEYS };

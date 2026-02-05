/**
 * Credential Service for Function Router
 *
 * Pre-fetches credentials from Dapr secret store before routing to OpenFunctions.
 * This centralizes credential management and avoids each OpenFunction needing
 * direct access to the secret store.
 */
import { SECRET_MAPPINGS } from "./types.js";

const DAPR_SECRETS_STORE = process.env.DAPR_SECRETS_STORE || "azure-keyvault";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";

/**
 * Fetch a single secret from Dapr secret store
 */
async function fetchDaprSecret(secretKey: string): Promise<string | undefined> {
  try {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/secrets/${DAPR_SECRETS_STORE}/${secretKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404) {
        return undefined;
      }
      console.warn(`[Credential Service] Dapr secret fetch failed for ${secretKey}: ${response.status}`);
      return undefined;
    }

    const data = await response.json() as Record<string, string>;
    return data[secretKey];
  } catch (error) {
    console.warn(`[Credential Service] Dapr secret store not available: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

/**
 * Integration config key to env var mapping
 */
const INTEGRATION_CONFIG_TO_ENV: Record<string, Record<string, string>> = {
  openai: { apiKey: "OPENAI_API_KEY" },
  anthropic: { apiKey: "ANTHROPIC_API_KEY" },
  slack: { botToken: "SLACK_BOT_TOKEN" },
  resend: { apiKey: "RESEND_API_KEY" },
  github: { token: "GITHUB_TOKEN", accessToken: "GITHUB_TOKEN" },
  linear: { apiKey: "LINEAR_API_KEY" },
  stripe: { secretKey: "STRIPE_SECRET_KEY" },
  firecrawl: { apiKey: "FIRECRAWL_API_KEY" },
  perplexity: { apiKey: "PERPLEXITY_API_KEY" },
  clerk: { secretKey: "CLERK_SECRET_KEY" },
  fal: { key: "FAL_KEY", apiKey: "FAL_KEY" },
  webflow: { apiToken: "WEBFLOW_API_TOKEN" },
  superagent: { apiKey: "SUPERAGENT_API_KEY" },
};

/**
 * Extract credentials from passed integrations object
 */
function extractPassedCredentials(
  integrations: Record<string, Record<string, string>>,
  integrationType: string
): Record<string, string> {
  const credentials: Record<string, string> = {};
  const integrationConfig = integrations[integrationType];

  if (!integrationConfig) {
    return credentials;
  }

  const mapping = INTEGRATION_CONFIG_TO_ENV[integrationType] || {};

  for (const [configKey, value] of Object.entries(integrationConfig)) {
    if (!value) continue;

    const envVar = mapping[configKey];
    if (envVar) {
      credentials[envVar] = value;
    } else {
      // Fallback: convert camelCase to SCREAMING_SNAKE_CASE
      const envName = configKey
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .toUpperCase();
      credentials[envName] = value;
    }
  }

  return credentials;
}

/**
 * Fetch credentials from Dapr secret store based on integration type
 */
async function fetchDaprCredentials(
  integrationType: string
): Promise<Record<string, string>> {
  const mapping = SECRET_MAPPINGS[integrationType];
  if (!mapping) {
    return {};
  }

  const credentials: Record<string, string> = {};

  console.log(`[Credential Service] Fetching Dapr secrets for ${integrationType}`);

  for (const [envVar, secretKey] of Object.entries(mapping)) {
    const value = await fetchDaprSecret(secretKey);
    if (value) {
      credentials[envVar] = value;
      console.log(`[Credential Service] Found Dapr secret: ${secretKey}`);
    }
  }

  return credentials;
}

/**
 * Fetch credentials for a function execution
 *
 * Priority:
 * 1. Passed integrations (from orchestrator)
 * 2. Dapr secret store (auto-injection from Azure Key Vault)
 *
 * Note: Database lookup is NOT done here - that's function-runner's job for fallback
 */
export async function fetchCredentials(
  integrationType: string,
  passedIntegrations?: Record<string, Record<string, string>>
): Promise<Record<string, string>> {
  // Step 1: Try passed integrations first (highest priority)
  if (passedIntegrations) {
    const passedCreds = extractPassedCredentials(passedIntegrations, integrationType);
    if (Object.keys(passedCreds).length > 0) {
      console.log(`[Credential Service] Using passed integrations for ${integrationType}:`, Object.keys(passedCreds));
      return passedCreds;
    }
  }

  // Step 2: Try Dapr secrets (auto-injection)
  const daprCreds = await fetchDaprCredentials(integrationType);
  if (Object.keys(daprCreds).length > 0) {
    console.log(`[Credential Service] Using Dapr secrets for ${integrationType}`);
    return daprCreds;
  }

  console.log(`[Credential Service] No credentials found for ${integrationType}`);
  return {};
}

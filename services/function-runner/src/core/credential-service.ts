/**
 * Credential Service
 *
 * Fetches integration credentials from multiple sources:
 * 1. Dapr Secret Store (Azure Key Vault) - auto-injection without UI config
 * 2. Database (encrypted) - user-configured integrations
 *
 * Priority: Dapr secrets take precedence, with database fallback.
 *
 * Uses raw SQL to avoid Drizzle type mismatches between monorepo packages.
 */
import { createDecipheriv } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "./db.js";
import type { WorkflowCredentials } from "./types.js";

// Type aliases (avoid importing from root to prevent Drizzle version conflicts)
type IntegrationType = string;
type IntegrationConfig = Record<string, string | undefined>;

// Encryption configuration (must match lib/db/integrations.ts)
const ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY_ENV = "INTEGRATION_ENCRYPTION_KEY";

/**
 * Get encryption key from environment
 */
function getEncryptionKey(): Buffer {
  const keyHex = process.env[ENCRYPTION_KEY_ENV];

  if (!keyHex) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} environment variable is required for decrypting integration credentials`
    );
  }

  if (keyHex.length !== 64) {
    throw new Error(
      `${ENCRYPTION_KEY_ENV} must be a 64-character hex string (32 bytes)`
    );
  }

  return Buffer.from(keyHex, "hex");
}

/**
 * Decrypt encrypted data
 */
function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  const parts = ciphertext.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

/**
 * Decrypt integration config object
 */
function decryptConfig(encryptedConfig: string): IntegrationConfig {
  try {
    const decrypted = decrypt(encryptedConfig);
    return JSON.parse(decrypted) as IntegrationConfig;
  } catch (error) {
    console.error("Failed to decrypt integration config:", error);
    return {};
  }
}

export type DecryptedIntegration = {
  id: string;
  userId: string;
  name: string;
  type: IntegrationType;
  config: IntegrationConfig;
  isManaged: boolean | null;
  createdAt: Date;
  updatedAt: Date;
};

// Raw query result type
type IntegrationRow = {
  id: string;
  user_id: string;
  name: string;
  type: string;
  config: string;
  is_managed: boolean | null;
  created_at: Date;
  updated_at: Date;
};

/**
 * Get a single integration by ID (for system use during workflow execution)
 * Uses raw SQL to avoid Drizzle type conflicts in monorepo
 */
export async function getIntegrationById(
  integrationId: string
): Promise<DecryptedIntegration | null> {
  const db = getDb();

  const result = await db.execute<IntegrationRow>(sql`
    SELECT id, user_id, name, type, config, is_managed, created_at, updated_at
    FROM integrations
    WHERE id = ${integrationId}
    LIMIT 1
  `);

  if (result.length === 0) {
    return null;
  }

  const row = result[0];
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    type: row.type,
    config: decryptConfig(row.config),
    isManaged: row.is_managed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Dapr Secrets Integration ────────────────────────────────────────────────

/**
 * Configuration for Dapr secrets store
 */
const DAPR_SECRETS_STORE = process.env.DAPR_SECRETS_STORE || "azure-keyvault";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";

/**
 * Feature flags
 */
function getFeatureFlags(): { daprSecretsEnabled: boolean; databaseFallback: boolean } {
  return {
    daprSecretsEnabled: process.env.DAPR_SECRETS_ENABLED !== "false",
    databaseFallback: process.env.SECRETS_FALLBACK_DB !== "false",
  };
}

/**
 * Mapping of integration types to their secret keys in the Dapr secret store.
 * Format: { integrationType: { ENV_VAR: "secret-key-in-vault" } }
 *
 * This enables auto-injection of API keys without requiring UI configuration.
 * Secret names use UPPERCASE-WITH-HYPHENS to match Azure Key Vault convention.
 */
const SECRET_MAPPINGS: Record<string, Record<string, string>> = {
  // AI providers
  openai: { OPENAI_API_KEY: "OPENAI-API-KEY" },
  anthropic: { ANTHROPIC_API_KEY: "ANTHROPIC-API-KEY" },

  // Communication
  slack: { SLACK_BOT_TOKEN: "SLACK-BOT-TOKEN" },
  resend: { RESEND_API_KEY: "RESEND-API-KEY" },

  // Developer tools
  github: { GITHUB_TOKEN: "GITHUB-TOKEN" },
  linear: { LINEAR_API_KEY: "LINEAR-API-KEY" },

  // Payment
  stripe: { STRIPE_SECRET_KEY: "STRIPE-SECRET-KEY" },

  // Web scraping / search
  firecrawl: { FIRECRAWL_API_KEY: "FIRECRAWL-API-KEY" },
  perplexity: { PERPLEXITY_API_KEY: "PERPLEXITY-API-KEY" },

  // Auth providers
  clerk: { CLERK_SECRET_KEY: "CLERK-SECRET-KEY" },

  // Media / AI
  fal: { FAL_KEY: "FAL-API-KEY" },

  // CMS
  webflow: { WEBFLOW_API_TOKEN: "WEBFLOW-API-TOKEN" },

  // AI guardrails
  superagent: { SUPERAGENT_API_KEY: "SUPERAGENT-API-KEY" },
};

/**
 * Fetch a single secret from Dapr secret store
 */
async function fetchDaprSecret(secretKey: string): Promise<string | undefined> {
  try {
    const url = `http://${DAPR_HOST}:${DAPR_HTTP_PORT}/v1.0/secrets/${DAPR_SECRETS_STORE}/${secretKey}`;
    const response = await fetch(url);

    if (!response.ok) {
      // Secret not found is common and not an error
      if (response.status === 404) {
        return undefined;
      }
      console.warn(`[Credential Service] Dapr secret fetch failed for ${secretKey}: ${response.status}`);
      return undefined;
    }

    const data = await response.json() as Record<string, string>;
    return data[secretKey];
  } catch (error) {
    // Dapr sidecar might not be available (local dev without Dapr)
    console.warn(`[Credential Service] Dapr secret store not available: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

/**
 * Fetch credentials from Dapr secret store based on integration type
 */
async function fetchDaprCredentials(
  integrationType: string
): Promise<WorkflowCredentials> {
  const mapping = SECRET_MAPPINGS[integrationType];
  if (!mapping) {
    return {};
  }

  const credentials: WorkflowCredentials = {};

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

// ─── Main Credential Fetching ────────────────────────────────────────────────

/**
 * Mapping of integration config keys to environment variable names
 * Used when extracting credentials from passed integrations
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
 * @param integrations - User integrations passed from orchestrator { "openai": { "apiKey": "..." } }
 * @param integrationType - Type of integration to extract
 */
function extractPassedCredentials(
  integrations: Record<string, Record<string, string>>,
  integrationType: string
): WorkflowCredentials {
  const credentials: WorkflowCredentials = {};

  // Check for exact type match
  const integrationConfig = integrations[integrationType];
  if (!integrationConfig) {
    return credentials;
  }

  // Get the mapping for this integration type
  const mapping = INTEGRATION_CONFIG_TO_ENV[integrationType] || {};

  for (const [configKey, value] of Object.entries(integrationConfig)) {
    if (!value) continue;

    // First check if there's a specific mapping for this config key
    const envVar = mapping[configKey];
    if (envVar) {
      credentials[envVar] = value;
    } else {
      // Fallback: convert camelCase to SCREAMING_SNAKE_CASE
      // e.g., apiKey -> API_KEY
      const envName = configKey
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .toUpperCase();
      credentials[envName] = value;
    }
  }

  return credentials;
}

/**
 * Fetch credentials for an integration.
 *
 * Priority:
 * 1. Passed integrations (from orchestrator)
 * 2. Dapr secret store (auto-injection from Azure Key Vault)
 * 3. Database integration (user-configured)
 *
 * @param integrationId - Optional ID of user-configured integration
 * @param integrationType - Type of integration (e.g., "slack", "github")
 * @param passedIntegrations - User integrations passed from orchestrator
 */
export async function fetchCredentials(
  integrationId?: string,
  integrationType?: string,
  passedIntegrations?: Record<string, Record<string, string>>
): Promise<WorkflowCredentials> {
  const credentials: WorkflowCredentials = {};
  const { daprSecretsEnabled, databaseFallback } = getFeatureFlags();

  // Step 1: Try passed integrations first (highest priority)
  if (integrationType && passedIntegrations) {
    const passedCreds = extractPassedCredentials(passedIntegrations, integrationType);
    if (Object.keys(passedCreds).length > 0) {
      console.log(`[Credential Service] Using passed integrations for ${integrationType}:`, Object.keys(passedCreds));
      Object.assign(credentials, passedCreds);
      // If we got passed credentials, return them immediately
      return credentials;
    }
  }

  // Step 2: Try Dapr secrets (auto-injection) if enabled
  if (integrationType && daprSecretsEnabled) {
    const daprCreds = await fetchDaprCredentials(integrationType);
    Object.assign(credentials, daprCreds);

    if (Object.keys(daprCreds).length > 0) {
      console.log(`[Credential Service] Using Dapr secrets for ${integrationType}`);
      // If we got Dapr secrets, we can skip database lookup
      // unless databaseFallback is enabled and some credentials are missing
      if (!databaseFallback) {
        return credentials;
      }
    }
  }

  // Step 3: Fallback to database (user-configured integration)
  if (integrationId && (databaseFallback || Object.keys(credentials).length === 0)) {
    console.log(`[Credential Service] Fetching database integration: ${integrationId}`);

    const integration = await getIntegrationById(integrationId);

    if (integration) {
      console.log(`[Credential Service] Found integration: ${integration.type}`);

      // Dynamically import the plugin registry to get credential mapping
      const { getIntegration, getCredentialMapping } = await import("@/plugins/registry.js");

      // Cast to any to avoid IntegrationType version mismatch
      const plugin = getIntegration(integration.type as never);
      if (plugin) {
        const dbCreds = getCredentialMapping(plugin, integration.config);
        // Only add credentials that weren't already set by Dapr
        for (const [key, value] of Object.entries(dbCreds)) {
          if (!credentials[key] && value) {
            credentials[key] = value;
          }
        }
        console.log(`[Credential Service] Merged database credentials for: ${integration.type}`);
      }
    }
  }

  // Fallback for system integrations (like database)
  if (integrationId && Object.keys(credentials).length === 0) {
    const integration = await getIntegrationById(integrationId);
    if (integration) {
      const systemMappers: Record<string, (config: IntegrationConfig) => WorkflowCredentials> = {
        database: (config) => {
          const creds: WorkflowCredentials = {};
          if (config.url) {
            creds.DATABASE_URL = config.url;
          }
          return creds;
        },
      };

      const mapper = systemMappers[integration.type];
      if (mapper) {
        Object.assign(credentials, mapper(integration.config));
      }
    }
  }

  if (Object.keys(credentials).length === 0) {
    console.log("[Credential Service] No credentials found");
  }

  return credentials;
}

/**
 * Credential Service for Function Router
 *
 * Pre-fetches credentials from Dapr secret store before routing to OpenFunctions.
 * This centralizes credential management and avoids each OpenFunction needing
 * direct access to the secret store.
 *
 * Includes audit logging for compliance and debugging.
 */
import { SECRET_MAPPINGS } from "./types.js";
import { getSql } from "./db.js";

const DAPR_SECRETS_STORE = process.env.DAPR_SECRETS_STORE || "azure-keyvault";
const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HOST = process.env.DAPR_HOST || "localhost";

const WORKFLOW_BUILDER_URL = process.env.WORKFLOW_BUILDER_URL
  || "http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

// AP server URL for direct connection decrypt (Daprized flows)
const AP_API_URL = process.env.AP_API_URL || "";

/**
 * Credential source types for audit logging
 */
export type CredentialSource =
  | "dapr_secret"
  | "request_body"
  | "not_found";

/**
 * Context for resolving AP connections (project/platform scoping)
 */
export interface ApConnectionContext {
  projectId: string;
  platformId: string;
}

/**
 * Audit context for credential resolution
 */
export interface CredentialAuditContext {
  executionId?: string;
  nodeId?: string;
}

/**
 * Result of credential fetch with audit information
 */
export interface CredentialFetchResult {
  credentials: Record<string, string>;
  source: CredentialSource;
  keys: string[];
  fallbackAttempted: boolean;
  fallbackReason?: string;
}

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
 * Map a decrypted connection value to environment variables based on connection type.
 * Handles SECRET_TEXT, OAUTH2, CLOUD_OAUTH2, PLATFORM_OAUTH2, BASIC_AUTH, and CUSTOM_AUTH.
 */
function mapConnectionValueToEnvVars(
  value: Record<string, unknown>,
  integrationType: string
): Record<string, string> {
  const mapping = INTEGRATION_CONFIG_TO_ENV[integrationType] || {};
  const credentials: Record<string, string> = {};

  switch (value.type) {
    case "SECRET_TEXT": {
      // Map secret_text to the first env var in the integration's mapping
      const envVar = Object.values(mapping)[0];
      if (envVar) credentials[envVar] = String(value.secret_text);
      break;
    }
    case "OAUTH2":
    case "CLOUD_OAUTH2":
    case "PLATFORM_OAUTH2": {
      // Map access_token to whichever env var the integration expects
      const token = String(value.access_token);
      const envVar = Object.values(mapping)[0];
      if (envVar) credentials[envVar] = token;
      break;
    }
    case "BASIC_AUTH": {
      credentials[`${integrationType.toUpperCase()}_USERNAME`] = String(value.username);
      credentials[`${integrationType.toUpperCase()}_PASSWORD`] = String(value.password);
      break;
    }
    case "CUSTOM_AUTH": {
      const props = (value.props as Record<string, unknown>) || {};
      for (const [key, val] of Object.entries(props)) {
        if (val != null) {
          const envVar = mapping[key];
          credentials[envVar || key.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()] = String(val);
        }
      }
      break;
    }
  }
  return credentials;
}

/**
 * Fetch decrypted credentials from the internal decrypt API.
 * The API handles OAuth2 token refresh automatically.
 */
async function fetchConnectionCredentials(
  connectionExternalId: string,
  integrationType: string,
  apContext?: ApConnectionContext,
): Promise<Record<string, string>> {
  try {
    let data: { id: string; externalId: string; type: string; pieceName: string; value: Record<string, unknown> };

    // Try AP's direct decrypt endpoint first when AP context is available
    if (AP_API_URL && apContext) {
      const url = `${AP_API_URL}/api/v1/dapr/connections/decrypt`;
      console.log(`[Credential Service] Fetching connection ${connectionExternalId} via AP decrypt API`);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          externalId: connectionExternalId,
          projectId: apContext.projectId,
          platformId: apContext.platformId,
        }),
      });

      if (response.ok) {
        data = await response.json() as typeof data;
        const creds = mapConnectionValueToEnvVars(data.value, integrationType);
        console.log(`[Credential Service] Fetched connection ${connectionExternalId} via AP API:`, Object.keys(creds));
        return creds;
      }
      console.warn(`[Credential Service] AP decrypt API returned ${response.status} for ${connectionExternalId}, falling back to WB`);
    }

    // Fallback: WB internal decrypt API
    const url = `${WORKFLOW_BUILDER_URL}/api/internal/connections/${connectionExternalId}/decrypt`;
    console.log(`[Credential Service] Fetching connection ${connectionExternalId} via WB decrypt API`);

    const response = await fetch(url, {
      headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
    });

    if (!response.ok) {
      console.warn(`[Credential Service] Decrypt API returned ${response.status} for ${connectionExternalId}`);
      return {};
    }

    data = await response.json() as typeof data;

    const creds = mapConnectionValueToEnvVars(data.value, integrationType);
    console.log(
      `[Credential Service] Fetched connection ${connectionExternalId} via WB decrypt API:`,
      Object.keys(creds)
    );
    return creds;
  } catch (error) {
    console.warn(
      `[Credential Service] Failed to fetch connection ${connectionExternalId}:`,
      error instanceof Error ? error.message : error
    );
    return {};
  }
}

/**
 * Fetch the raw decrypted connection value for Activepieces actions.
 * Returns the raw AppConnectionValue (OAuth2/SecretText/BasicAuth/CustomAuth)
 * that can be passed directly to AP action context.auth.
 */
export async function fetchRawConnectionValue(
  connectionExternalId: string,
  apContext?: ApConnectionContext,
): Promise<unknown | null> {
  try {
    let data: { id: string; externalId: string; type: string; pieceName: string; value: Record<string, unknown> };

    // Try AP's direct decrypt endpoint first when AP context is available
    if (AP_API_URL && apContext) {
      const url = `${AP_API_URL}/api/v1/dapr/connections/decrypt`;
      console.log(`[Credential Service] Fetching raw connection ${connectionExternalId} via AP API`);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          externalId: connectionExternalId,
          projectId: apContext.projectId,
          platformId: apContext.platformId,
        }),
      });

      if (response.ok) {
        data = await response.json() as typeof data;
        console.log(`[Credential Service] Fetched raw connection ${connectionExternalId} via AP API: type=${data.value?.type}`);
        return data.value;
      }
      console.warn(`[Credential Service] AP decrypt API returned ${response.status} for ${connectionExternalId}, falling back to WB`);
    }

    // Fallback: WB internal decrypt API
    const url = `${WORKFLOW_BUILDER_URL}/api/internal/connections/${connectionExternalId}/decrypt`;
    console.log(`[Credential Service] Fetching raw connection ${connectionExternalId} via WB API`);

    const response = await fetch(url, {
      headers: { "X-Internal-Token": INTERNAL_API_TOKEN },
    });

    if (!response.ok) {
      console.warn(`[Credential Service] Decrypt API returned ${response.status} for ${connectionExternalId}`);
      return null;
    }

    data = await response.json() as typeof data;
    console.log(`[Credential Service] Fetched raw connection ${connectionExternalId}: type=${data.value?.type}`);
    return data.value;
  } catch (error) {
    console.warn(
      `[Credential Service] Failed to fetch raw connection ${connectionExternalId}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}

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

/**
 * Generate a random ID for audit log entries
 */
function generateAuditId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (let i = 0; i < 24; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Log credential access to the audit table
 */
async function logCredentialAccess(
  executionId: string,
  nodeId: string,
  integrationType: string,
  result: CredentialFetchResult
): Promise<void> {
  const sql = getSql();
  const id = generateAuditId();

  try {
    await sql`
      INSERT INTO credential_access_logs (
        id, execution_id, node_id, integration_type, credential_keys,
        source, fallback_attempted, fallback_reason, accessed_at
      ) VALUES (
        ${id},
        ${executionId},
        ${nodeId},
        ${integrationType},
        ${JSON.stringify(result.keys)},
        ${result.source},
        ${result.fallbackAttempted},
        ${result.fallbackReason || null},
        NOW()
      )
    `;
    console.log(`[Credential Service] Logged credential access: ${id} (source: ${result.source})`);
  } catch (error) {
    console.error(`[Credential Service] Failed to log credential access:`, error);
    // Don't throw - audit logging failure shouldn't break execution
  }
}

/**
 * Fetch credentials for a function execution with audit logging
 *
 * Priority:
 * 1. Passed integrations (from orchestrator)
 * 2. Dapr secret store (auto-injection from Azure Key Vault)
 *
 * @param integrationType - The integration type (e.g., "openai", "slack")
 * @param passedIntegrations - Credentials passed from the orchestrator
 * @param auditContext - Optional context for audit logging
 * @returns Credentials and audit information
 */
export async function fetchCredentialsWithAudit(
  integrationType: string,
  passedIntegrations?: Record<string, Record<string, string>>,
  auditContext?: CredentialAuditContext,
  connectionExternalId?: string,
  apContext?: ApConnectionContext,
): Promise<CredentialFetchResult> {
  let result: CredentialFetchResult = {
    credentials: {},
    source: "not_found",
    keys: [],
    fallbackAttempted: false,
  };

  // Step 0 (NEW): Try internal decrypt API — highest priority
  if (connectionExternalId) {
    const creds = await fetchConnectionCredentials(connectionExternalId, integrationType, apContext);
    if (Object.keys(creds).length > 0) {
      result = {
        credentials: creds,
        source: "request_body",
        keys: Object.keys(creds),
        fallbackAttempted: false,
      };

      if (auditContext?.executionId && auditContext?.nodeId) {
        await logCredentialAccess(
          auditContext.executionId,
          auditContext.nodeId,
          integrationType,
          result
        );
      }

      return result;
    }
  }

  // Step 1: Try passed integrations (legacy fallback)
  if (passedIntegrations) {
    const passedCreds = extractPassedCredentials(passedIntegrations, integrationType);
    if (Object.keys(passedCreds).length > 0) {
      console.log(`[Credential Service] Using passed integrations for ${integrationType}:`, Object.keys(passedCreds));
      result = {
        credentials: passedCreds,
        source: "request_body",
        keys: Object.keys(passedCreds),
        fallbackAttempted: false,
      };

      // Log to audit table if context provided
      if (auditContext?.executionId && auditContext?.nodeId) {
        await logCredentialAccess(
          auditContext.executionId,
          auditContext.nodeId,
          integrationType,
          result
        );
      }

      return result;
    }
  }

  // Step 2: Try Dapr secrets (auto-injection) - this is a fallback from request_body
  result.fallbackAttempted = true;
  result.fallbackReason = "No credentials in request body";

  const daprCreds = await fetchDaprCredentials(integrationType);
  if (Object.keys(daprCreds).length > 0) {
    console.log(`[Credential Service] Using Dapr secrets for ${integrationType}`);
    result = {
      credentials: daprCreds,
      source: "dapr_secret",
      keys: Object.keys(daprCreds),
      fallbackAttempted: true,
      fallbackReason: "No credentials in request body, used Dapr secret store",
    };

    // Log to audit table if context provided
    if (auditContext?.executionId && auditContext?.nodeId) {
      await logCredentialAccess(
        auditContext.executionId,
        auditContext.nodeId,
        integrationType,
        result
      );
    }

    return result;
  }

  // Step 3: No credentials found
  console.log(`[Credential Service] No credentials found for ${integrationType}`);
  result = {
    credentials: {},
    source: "not_found",
    keys: [],
    fallbackAttempted: true,
    fallbackReason: "No credentials in request body, Dapr secret store returned empty",
  };

  // Log to audit table if context provided
  if (auditContext?.executionId && auditContext?.nodeId) {
    await logCredentialAccess(
      auditContext.executionId,
      auditContext.nodeId,
      integrationType,
      result
    );
  }

  return result;
}

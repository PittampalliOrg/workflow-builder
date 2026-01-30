/**
 * Credential Service
 *
 * Fetches and decrypts integration credentials from the database.
 * Adapted from lib/db/integrations.ts and lib/credential-fetcher.ts
 *
 * Uses raw SQL to avoid Drizzle type mismatches between monorepo packages.
 */
import { createDecipheriv } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "./db.js";

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

/**
 * Workflow credentials type
 */
export type WorkflowCredentials = Record<string, string | undefined>;

/**
 * Get credential mapping for a plugin based on its form fields
 * This dynamically imports the plugin registry to get the credential mapping
 */
export async function fetchCredentials(
  integrationId: string
): Promise<WorkflowCredentials> {
  console.log("[Credential Service] Fetching integration:", integrationId);

  const integration = await getIntegrationById(integrationId);

  if (!integration) {
    console.log("[Credential Service] Integration not found");
    return {};
  }

  console.log("[Credential Service] Found integration:", integration.type);

  // Dynamically import the plugin registry to get credential mapping
  // This allows us to reuse the plugin definitions without duplicating the mapping logic
  const { getIntegration, getCredentialMapping } = await import("@/plugins/registry.js");

  // Cast to any to avoid IntegrationType version mismatch
  const plugin = getIntegration(integration.type as never);
  if (plugin) {
    const credentials = getCredentialMapping(plugin, integration.config);
    console.log("[Credential Service] Returning credentials for type:", integration.type);
    return credentials;
  }

  // Fallback for system integrations (like database)
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
    return mapper(integration.config);
  }

  console.log("[Credential Service] No mapping found for type:", integration.type);
  return {};
}

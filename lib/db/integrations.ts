import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { decrypt, encrypt } from "../security/encryption";
import type { IntegrationConfig, IntegrationType } from "../types/integration";
import { extractConnectionExternalIdsFromNodes } from "./app-connections";
import { db } from "./index";
import { appConnections, integrations, type NewIntegration } from "./schema";

/**
 * Encrypt integration config object
 */
function encryptConfig(config: Record<string, unknown>): string {
  return encrypt(JSON.stringify(config));
}

/**
 * Decrypt integration config object
 */
function decryptConfig(encryptedConfig: string): Record<string, unknown> {
  try {
    const decrypted = decrypt(encryptedConfig);
    return JSON.parse(decrypted) as Record<string, unknown>;
  } catch {
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

/**
 * Get all integrations for a user, optionally filtered by type
 */
export async function getIntegrations(
  userId: string,
  type?: IntegrationType
): Promise<DecryptedIntegration[]> {
  const conditions = [eq(integrations.userId, userId)];

  if (type) {
    conditions.push(eq(integrations.type, type));
  }

  const results = await db
    .select()
    .from(integrations)
    .where(and(...conditions));

  return results.map((integration) => ({
    ...integration,
    config: decryptConfig(integration.config as string) as IntegrationConfig,
  }));
}

/**
 * Get a single integration by ID
 */
export async function getIntegration(
  integrationId: string,
  userId: string
): Promise<DecryptedIntegration | null> {
  const result = await db
    .select()
    .from(integrations)
    .where(
      and(eq(integrations.id, integrationId), eq(integrations.userId, userId))
    )
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  return {
    ...result[0],
    config: decryptConfig(result[0].config as string) as IntegrationConfig,
  };
}

/**
 * Get a single integration by ID without user check (for system use during workflow execution)
 */
export async function getIntegrationById(
  integrationId: string
): Promise<DecryptedIntegration | null> {
  const result = await db
    .select()
    .from(integrations)
    .where(eq(integrations.id, integrationId))
    .limit(1);

  if (result.length === 0) {
    return null;
  }

  return {
    ...result[0],
    config: decryptConfig(result[0].config as string) as IntegrationConfig,
  };
}

/**
 * Create a new integration
 */
export async function createIntegration(
  userId: string,
  name: string,
  type: IntegrationType,
  config: IntegrationConfig
): Promise<DecryptedIntegration> {
  const encryptedConfig = encryptConfig(config);

  const [result] = await db
    .insert(integrations)
    .values({
      userId,
      name,
      type,
      config: encryptedConfig,
    })
    .returning();

  return {
    ...result,
    config,
  };
}

/**
 * Update an integration
 */
export async function updateIntegration(
  integrationId: string,
  userId: string,
  updates: {
    name?: string;
    config?: IntegrationConfig;
  }
): Promise<DecryptedIntegration | null> {
  const updateData: Partial<NewIntegration> = {
    updatedAt: new Date(),
  };

  if (updates.name !== undefined) {
    updateData.name = updates.name;
  }

  if (updates.config !== undefined) {
    updateData.config = encryptConfig(updates.config);
  }

  const [result] = await db
    .update(integrations)
    .set(updateData)
    .where(
      and(eq(integrations.id, integrationId), eq(integrations.userId, userId))
    )
    .returning();

  if (!result) {
    return null;
  }

  return {
    ...result,
    config: decryptConfig(result.config as string) as IntegrationConfig,
  };
}

/**
 * Delete an integration
 */
export async function deleteIntegration(
  integrationId: string,
  userId: string
): Promise<boolean> {
  const result = await db
    .delete(integrations)
    .where(
      and(eq(integrations.id, integrationId), eq(integrations.userId, userId))
    )
    .returning();

  return result.length > 0;
}

/**
 * Workflow node structure for validation
 */
type WorkflowNodeForValidation = {
  data?: {
    config?: {
      integrationId?: string;
      auth?: string;
    };
  };
};

/**
 * Extract all integration IDs from workflow nodes
 */
export function extractIntegrationIds(
  nodes: WorkflowNodeForValidation[]
): string[] {
  const integrationIds: string[] = [];

  for (const node of nodes) {
    const integrationId = node.data?.config?.integrationId;
    if (integrationId && typeof integrationId === "string") {
      integrationIds.push(integrationId);
    }
  }

  return [...new Set(integrationIds)];
}

/**
 * Validate that integration references in workflow nodes do not point to other users.
 *
 * Rules:
 * 1. Legacy integration IDs must belong to user (or be missing/deleted)
 * 2. Activepieces external connection IDs in `auth` templates must belong to user
 */
export async function validateWorkflowIntegrations(
  nodes: WorkflowNodeForValidation[],
  userId: string
): Promise<{ valid: boolean; invalidIds?: string[] }> {
  const integrationIds = extractIntegrationIds(nodes);

  const invalidIds: string[] = [];

  if (integrationIds.length > 0) {
    const existingIntegrations = await db
      .select({ id: integrations.id, userId: integrations.userId })
      .from(integrations)
      .where(inArray(integrations.id, integrationIds));

    invalidIds.push(
      ...existingIntegrations
        .filter((integration) => integration.userId !== userId)
        .map((integration) => integration.id)
    );
  }

  const connectionExternalIds = extractConnectionExternalIdsFromNodes(nodes);
  if (connectionExternalIds.length > 0) {
    const existingConnections = await db
      .select({
        externalId: appConnections.externalId,
        ownerId: appConnections.ownerId,
      })
      .from(appConnections)
      .where(inArray(appConnections.externalId, connectionExternalIds));

    invalidIds.push(
      ...existingConnections
        .filter((connection) => connection.ownerId !== userId)
        .map((connection) => connection.externalId)
    );
  }

  if (invalidIds.length > 0) {
    return { valid: false, invalidIds };
  }

  return { valid: true };
}

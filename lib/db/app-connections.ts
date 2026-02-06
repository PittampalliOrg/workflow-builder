import "server-only";

import { and, eq, inArray, like } from "drizzle-orm";
import { decryptJson, encryptJson } from "@/lib/security/encryption";
import {
  AppConnectionScope,
  AppConnectionStatus,
  type AppConnectionValue,
  type AppConnectionWithoutSensitiveData,
  type ListAppConnectionsRequestQuery,
  type UpdateConnectionValueRequestBody,
  type UpsertAppConnectionRequestBody,
} from "@/lib/types/app-connection";
import { generateId } from "@/lib/utils/id";
import { db } from "./index";
import { appConnections } from "./schema";

export type DecryptedAppConnection = Omit<
  typeof appConnections.$inferSelect,
  "value"
> & {
  value: AppConnectionValue;
};

export function removeSensitiveData(
  connection: DecryptedAppConnection
): AppConnectionWithoutSensitiveData {
  const { value: _, metadata, ...rest } = connection;
  return {
    ...rest,
    metadata: (metadata ?? null) as Record<string, unknown> | null,
    createdAt: rest.createdAt.toISOString(),
    updatedAt: rest.updatedAt.toISOString(),
  };
}

function decryptConnection(
  row: typeof appConnections.$inferSelect
): DecryptedAppConnection {
  return {
    ...row,
    metadata: (row.metadata ?? null) as Record<string, unknown> | null,
    value: decryptJson(row.value) as AppConnectionValue,
  };
}

function coerceConnectionValue(
  body: UpsertAppConnectionRequestBody
): AppConnectionValue {
  return body.value as AppConnectionValue;
}

export async function upsertAppConnection(
  ownerId: string,
  body: UpsertAppConnectionRequestBody
): Promise<DecryptedAppConnection> {
  const existing = await db.query.appConnections.findFirst({
    where: and(
      eq(appConnections.ownerId, ownerId),
      eq(appConnections.externalId, body.externalId)
    ),
  });

  const encryptedValue = encryptJson(coerceConnectionValue(body));
  const now = new Date();

  if (existing) {
    const [updated] = await db
      .update(appConnections)
      .set({
        displayName: body.displayName,
        pieceName: body.pieceName,
        pieceVersion: body.pieceVersion ?? existing.pieceVersion,
        type: body.type,
        value: encryptedValue,
        metadata: body.metadata,
        status: AppConnectionStatus.ACTIVE,
        updatedAt: now,
      })
      .where(eq(appConnections.id, existing.id))
      .returning();

    return decryptConnection(updated);
  }

  const [created] = await db
    .insert(appConnections)
    .values({
      id: generateId(),
      displayName: body.displayName,
      externalId: body.externalId,
      type: body.type,
      status: AppConnectionStatus.ACTIVE,
      platformId: null,
      pieceName: body.pieceName,
      ownerId,
      projectIds: [],
      scope: AppConnectionScope.PROJECT,
      value: encryptedValue,
      metadata: body.metadata ?? null,
      pieceVersion: body.pieceVersion ?? "0.0.0",
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return decryptConnection(created);
}

export async function listAppConnections(params: {
  ownerId: string;
  query: ListAppConnectionsRequestQuery;
}): Promise<DecryptedAppConnection[]> {
  const conditions = [eq(appConnections.ownerId, params.ownerId)];

  if (params.query.pieceName) {
    conditions.push(eq(appConnections.pieceName, params.query.pieceName));
  }

  if (params.query.displayName) {
    conditions.push(
      like(appConnections.displayName, `%${params.query.displayName}%`)
    );
  }

  if (params.query.scope) {
    conditions.push(eq(appConnections.scope, params.query.scope));
  }

  if (params.query.status && params.query.status.length > 0) {
    conditions.push(inArray(appConnections.status, params.query.status));
  }

  const rows = await db
    .select()
    .from(appConnections)
    .where(and(...conditions))
    .limit(params.query.limit ?? 100);

  return rows.map(decryptConnection);
}

export async function getAppConnectionById(
  id: string,
  ownerId: string
): Promise<DecryptedAppConnection | null> {
  const row = await db.query.appConnections.findFirst({
    where: and(eq(appConnections.id, id), eq(appConnections.ownerId, ownerId)),
  });

  if (!row) {
    return null;
  }

  return decryptConnection(row);
}

export async function getAppConnectionByExternalId(
  externalId: string,
  ownerId: string
): Promise<DecryptedAppConnection | null> {
  const row = await db.query.appConnections.findFirst({
    where: and(
      eq(appConnections.externalId, externalId),
      eq(appConnections.ownerId, ownerId)
    ),
  });

  if (!row) {
    return null;
  }

  return decryptConnection(row);
}

export async function updateAppConnection(
  id: string,
  ownerId: string,
  updates: UpdateConnectionValueRequestBody
): Promise<DecryptedAppConnection | null> {
  const [row] = await db
    .update(appConnections)
    .set({
      displayName: updates.displayName,
      metadata: updates.metadata,
      updatedAt: new Date(),
    })
    .where(and(eq(appConnections.id, id), eq(appConnections.ownerId, ownerId)))
    .returning();

  if (!row) {
    return null;
  }

  return decryptConnection(row);
}

export async function updateAppConnectionSecretValue(params: {
  id: string;
  ownerId: string;
  value: AppConnectionValue;
  displayName?: string;
}): Promise<DecryptedAppConnection | null> {
  const [row] = await db
    .update(appConnections)
    .set({
      value: encryptJson(params.value),
      ...(params.displayName ? { displayName: params.displayName } : {}),
      status: AppConnectionStatus.ACTIVE,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appConnections.id, params.id),
        eq(appConnections.ownerId, params.ownerId)
      )
    )
    .returning();

  if (!row) {
    return null;
  }

  return decryptConnection(row);
}

export async function deleteAppConnection(
  id: string,
  ownerId: string
): Promise<boolean> {
  const rows = await db
    .delete(appConnections)
    .where(and(eq(appConnections.id, id), eq(appConnections.ownerId, ownerId)))
    .returning();

  return rows.length > 0;
}

export function parseConnectionExternalIdFromAuth(
  auth: unknown
): string | null {
  if (typeof auth !== "string") {
    return null;
  }

  const match = auth.match(/\{\{connections\[['"]([^'"]+)['"]\]\}\}/);
  return match?.[1] ?? null;
}

export function extractConnectionExternalIdsFromNodes(
  nodes: unknown[]
): string[] {
  const ids = new Set<string>();

  for (const node of nodes) {
    if (!node || typeof node !== "object") {
      continue;
    }

    const data = (node as { data?: Record<string, unknown> }).data;
    const config = data?.config as Record<string, unknown> | undefined;

    const authExternalId = parseConnectionExternalIdFromAuth(config?.auth);
    if (authExternalId) {
      ids.add(authExternalId);
    }
  }

  return Array.from(ids);
}

export async function validateWorkflowAppConnections(
  nodes: unknown[],
  ownerId: string
): Promise<{ valid: boolean; invalidExternalIds?: string[] }> {
  const externalIds = extractConnectionExternalIdsFromNodes(nodes);

  if (externalIds.length === 0) {
    return { valid: true };
  }

  const rows = await db
    .select({
      externalId: appConnections.externalId,
      ownerId: appConnections.ownerId,
    })
    .from(appConnections)
    .where(inArray(appConnections.externalId, externalIds));

  const invalidExternalIds = rows
    .filter((row) => row.ownerId !== ownerId)
    .map((row) => row.externalId);

  if (invalidExternalIds.length > 0) {
    return { valid: false, invalidExternalIds };
  }

  return { valid: true };
}

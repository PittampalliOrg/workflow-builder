import "server-only";

import { eq } from "drizzle-orm";
import { db } from "./index";
import { oauthApps } from "./schema";
import {
  encryptString,
  decryptString,
  type EncryptedObject,
} from "@/lib/security/encryption";
import { generateId } from "@/lib/utils/id";

export type DecryptedOAuthApp = {
  id: string;
  pieceName: string;
  clientId: string;
  clientSecret: string; // decrypted plaintext
  extraParams?: Record<string, string>;
};

export type OAuthAppSummary = {
  id: string;
  pieceName: string;
  clientId: string;
  hasSecret: boolean;
  extraParams?: Record<string, string>;
};

function decryptOAuthApp(
  row: typeof oauthApps.$inferSelect
): DecryptedOAuthApp {
  return {
    id: row.id,
    pieceName: row.pieceName,
    clientId: row.clientId,
    clientSecret: decryptString(row.clientSecret as EncryptedObject),
    extraParams: (row.extraParams as Record<string, string>) ?? undefined,
  };
}

function toSummary(row: typeof oauthApps.$inferSelect): OAuthAppSummary {
  return {
    id: row.id,
    pieceName: row.pieceName,
    clientId: row.clientId,
    hasSecret: true,
    extraParams: (row.extraParams as Record<string, string>) ?? undefined,
  };
}

export async function getOAuthAppByPieceName(
  pieceName: string
): Promise<DecryptedOAuthApp | null> {
  const row = await db.query.oauthApps.findFirst({
    where: eq(oauthApps.pieceName, pieceName),
  });

  if (!row) return null;
  return decryptOAuthApp(row);
}

export async function listOAuthApps(): Promise<OAuthAppSummary[]> {
  const rows = await db.select().from(oauthApps);
  return rows.map(toSummary);
}

export async function upsertOAuthApp(params: {
  pieceName: string;
  clientId: string;
  clientSecret: string;
  extraParams?: Record<string, string>;
}): Promise<OAuthAppSummary> {
  const encryptedSecret = encryptString(params.clientSecret);
  const now = new Date();

  const existing = await db.query.oauthApps.findFirst({
    where: eq(oauthApps.pieceName, params.pieceName),
  });

  if (existing) {
    const [updated] = await db
      .update(oauthApps)
      .set({
        clientId: params.clientId,
        clientSecret: encryptedSecret,
        extraParams: params.extraParams ?? null,
        updatedAt: now,
      })
      .where(eq(oauthApps.id, existing.id))
      .returning();

    return toSummary(updated);
  }

  const [created] = await db
    .insert(oauthApps)
    .values({
      id: generateId(),
      pieceName: params.pieceName,
      clientId: params.clientId,
      clientSecret: encryptedSecret,
      extraParams: params.extraParams ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return toSummary(created);
}

export async function deleteOAuthApp(pieceName: string): Promise<boolean> {
  const rows = await db
    .delete(oauthApps)
    .where(eq(oauthApps.pieceName, pieceName))
    .returning();

  return rows.length > 0;
}

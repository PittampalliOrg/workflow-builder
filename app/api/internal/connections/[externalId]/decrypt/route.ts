import { NextResponse } from "next/server";
import { getAppConnectionByExternalIdInternal } from "@/lib/db/app-connections";
import { encryptObject } from "@/lib/security/encryption";
import {
  AppConnectionType,
  type OAuth2ConnectionValueWithApp,
} from "@/lib/types/app-connection";
import {
  isOAuth2TokenExpired,
  refreshOAuth2Token,
} from "@/lib/app-connections/oauth2-refresh";
import { appConnections } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN;

/**
 * Internal API: Decrypt a connection's value by externalId.
 *
 * Called by function-router to retrieve decrypted credentials at execution time.
 * For OAuth2 connections, automatically refreshes expired tokens.
 *
 * Security: Validated via X-Internal-Token header.
 * In production, Kubernetes network policy restricts access to function-router only.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ externalId: string }> }
) {
  // Validate internal token
  const token = _request.headers.get("X-Internal-Token");
  if (!INTERNAL_API_TOKEN || token !== INTERNAL_API_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { externalId } = await params;

  const connection = await getAppConnectionByExternalIdInternal(externalId);
  if (!connection) {
    return NextResponse.json(
      { error: "Connection not found" },
      { status: 404 }
    );
  }

  let value = connection.value;

  // Auto-refresh expired OAuth2 tokens
  if (
    connection.type === AppConnectionType.OAUTH2 &&
    value.type === AppConnectionType.OAUTH2
  ) {
    const oauth2Value = value as OAuth2ConnectionValueWithApp;
    if (isOAuth2TokenExpired(oauth2Value)) {
      try {
        const refreshedValue = await refreshOAuth2Token(oauth2Value);

        // Persist the refreshed token
        await db
          .update(appConnections)
          .set({
            value: encryptObject(refreshedValue),
            updatedAt: new Date(),
          })
          .where(eq(appConnections.id, connection.id));

        value = refreshedValue;
      } catch (error) {
        console.error(
          `Failed to refresh OAuth2 token for connection ${externalId}:`,
          error
        );
        // Return the existing (possibly expired) value — let the caller handle the failure
      }
    }
  }

  return NextResponse.json({
    id: connection.id,
    externalId: connection.externalId,
    type: connection.type,
    pieceName: connection.pieceName,
    value,
  });
}

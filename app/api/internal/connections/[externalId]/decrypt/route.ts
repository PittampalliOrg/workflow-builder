import { NextResponse } from "next/server";
import { getAppConnectionByExternalIdInternal } from "@/lib/db/app-connections";
import { resolveConnectionValueForUse } from "@/lib/app-connections/resolve-connection-value";

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

  const value = await resolveConnectionValueForUse(connection);

  return NextResponse.json({
    id: connection.id,
    externalId: connection.externalId,
    type: connection.type,
    pieceName: connection.pieceName,
    value,
  });
}

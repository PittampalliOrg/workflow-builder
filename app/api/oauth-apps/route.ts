import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { getSession } from "@/lib/auth-helpers";
import { db } from "@/lib/db";
import { platformOauthApps } from "@/lib/db/schema";
import { ensureDefaultPlatform } from "@/lib/platform-service";
import { encryptString } from "@/lib/security/encryption";

/** Ensure piece name has full AP package prefix */
function toFullPieceName(name: string): string {
  if (name.startsWith("@activepieces/piece-")) return name;
  return `@activepieces/piece-${name}`;
}

/**
 * GET /api/oauth-apps - List all platform OAuth apps (never returns clientSecret)
 */
export async function GET(request: Request) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const platform = await ensureDefaultPlatform();
  const apps = await db
    .select({
      pieceName: platformOauthApps.pieceName,
      clientId: platformOauthApps.clientId,
      createdAt: platformOauthApps.createdAt,
      updatedAt: platformOauthApps.updatedAt,
    })
    .from(platformOauthApps)
    .where(eq(platformOauthApps.platformId, platform.id));

  // Normalize pieceName: DB stores full AP names (@activepieces/piece-X)
  // but piece_metadata.name uses short names (X). Return both formats.
  const normalized = apps.map((a) => ({
    ...a,
    pieceName: a.pieceName,
    pieceShortName: a.pieceName.replace(/^@activepieces\/piece-/, ""),
  }));

  return NextResponse.json(normalized);
}

/**
 * POST /api/oauth-apps - Upsert an OAuth app for a piece
 * clientSecret is AES-256-CBC encrypted before storage (AP-compatible)
 */
export async function POST(request: Request) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { clientId, clientSecret } = body;
  const pieceName = body.pieceName ? toFullPieceName(body.pieceName) : null;

  if (!pieceName || !clientId || !clientSecret) {
    return NextResponse.json(
      { error: "pieceName, clientId, and clientSecret are required" },
      { status: 400 }
    );
  }

  const platform = await ensureDefaultPlatform();
  const encryptedSecret = encryptString(clientSecret);

  // Check if exists
  const existing = await db
    .select()
    .from(platformOauthApps)
    .where(
      and(
        eq(platformOauthApps.platformId, platform.id),
        eq(platformOauthApps.pieceName, pieceName)
      )
    )
    .limit(1);

  let resultApp;

  if (existing.length > 0) {
    // Update
    const updated = await db
      .update(platformOauthApps)
      .set({ clientId, clientSecret: encryptedSecret, updatedAt: new Date() })
      .where(eq(platformOauthApps.id, existing[0].id))
      .returning({
        pieceName: platformOauthApps.pieceName,
        clientId: platformOauthApps.clientId,
        createdAt: platformOauthApps.createdAt,
        updatedAt: platformOauthApps.updatedAt,
      });
    resultApp = updated[0];
  } else {
    // Insert
    const inserted = await db
      .insert(platformOauthApps)
      .values({
        platformId: platform.id,
        pieceName,
        clientId,
        clientSecret: encryptedSecret,
      })
      .returning({
        pieceName: platformOauthApps.pieceName,
        clientId: platformOauthApps.clientId,
        createdAt: platformOauthApps.createdAt,
        updatedAt: platformOauthApps.updatedAt,
      });
    resultApp = inserted[0];
  }

  return NextResponse.json(resultApp);
}

/**
 * DELETE /api/oauth-apps - Delete an OAuth app by pieceName
 */
export async function DELETE(request: Request) {
  const session = await getSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const rawPieceName = searchParams.get("pieceName");
  const pieceName = rawPieceName ? toFullPieceName(rawPieceName) : null;

  if (!pieceName) {
    return NextResponse.json(
      { error: "pieceName is required" },
      { status: 400 }
    );
  }

  const platform = await ensureDefaultPlatform();

  await db
    .delete(platformOauthApps)
    .where(
      and(
        eq(platformOauthApps.platformId, platform.id),
        eq(platformOauthApps.pieceName, pieceName)
      )
    );

  return NextResponse.json({ success: true });
}

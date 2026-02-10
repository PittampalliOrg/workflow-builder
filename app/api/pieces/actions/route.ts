import { NextResponse } from "next/server";
import { convertApPiecesToIntegrations } from "@/lib/activepieces/action-adapter";
import { isPieceInstalled } from "@/lib/activepieces/installed-pieces";
import { getSession } from "@/lib/auth-helpers";
import { listPieceMetadata } from "@/lib/db/piece-metadata";

// In-memory cache with 5-min TTL
let cache: { data: unknown; timestamp: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * GET /api/pieces/actions
 *
 * Returns installed Activepieces pieces with their actions converted to
 * Workflow Builder format (ActionConfigField[]).
 *
 * Only pieces listed in installed-pieces.ts are returned — these are the
 * pieces with npm packages bundled into fn-activepieces for runtime execution.
 */
export async function GET(request: Request) {
  try {
    const session = await getSession(request);

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Return cached data if fresh
    const now = Date.now();
    if (cache && now - cache.timestamp < CACHE_TTL_MS) {
      return NextResponse.json(cache.data);
    }

    // Fetch all piece metadata from DB, then filter to installed pieces only
    const allPieces = await listPieceMetadata({});
    const pieces = allPieces.filter((p) => isPieceInstalled(p.name));

    // Convert to WB format
    const integrations = convertApPiecesToIntegrations(pieces);

    const responseData = { pieces: integrations };

    // Update cache
    cache = { data: responseData, timestamp: now };

    return NextResponse.json(responseData);
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to load piece actions",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

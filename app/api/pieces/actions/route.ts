import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listPieceMetadata } from "@/lib/db/piece-metadata";
import { convertApPiecesToIntegrations } from "@/lib/activepieces/action-adapter";

// In-memory cache with 5-min TTL
let cache: { data: unknown; timestamp: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * GET /api/pieces/actions
 *
 * Returns all Activepieces pieces with their actions converted to
 * Workflow Builder format (ActionConfigField[]).
 */
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Return cached data if fresh
    const now = Date.now();
    if (cache && now - cache.timestamp < CACHE_TTL_MS) {
      return NextResponse.json(cache.data);
    }

    // Fetch all piece metadata from DB
    const pieces = await listPieceMetadata({});

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

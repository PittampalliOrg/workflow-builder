/**
 * ActivePieces Pieces API
 *
 * GET /api/activepieces/pieces - List available ActivePieces pieces
 *
 * This endpoint fetches the list of pieces from the database
 * (seeded via seed-activepieces-functions.ts) and returns them
 * organized for the UI.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { functions } from "@/lib/db/schema";
import { eq, like, and, sql } from "drizzle-orm";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const search = searchParams.get("search");
    const pieceName = searchParams.get("piece");

    // Build query conditions
    const conditions = [
      // Only ActivePieces functions (slug starts with "ap-")
      sql`${functions.slug} LIKE 'ap-%'`,
      // Only enabled functions
      eq(functions.isEnabled, true),
    ];

    // Filter by piece name if specified
    if (pieceName) {
      conditions.push(like(functions.pluginId, `activepieces-${pieceName}`));
    }

    // Search in name or description
    if (search) {
      conditions.push(
        sql`(${functions.name} ILIKE ${`%${search}%`} OR ${functions.description} ILIKE ${`%${search}%`})`
      );
    }

    // Fetch functions
    const apFunctions = await db
      .select({
        id: functions.id,
        name: functions.name,
        slug: functions.slug,
        description: functions.description,
        pluginId: functions.pluginId,
        version: functions.version,
        inputSchema: functions.inputSchema,
        integrationType: functions.integrationType,
      })
      .from(functions)
      .where(and(...conditions))
      .orderBy(functions.pluginId, functions.name);

    // Group by piece (pluginId)
    const pieceMap = new Map<
      string,
      {
        name: string;
        displayName: string;
        actions: Array<{
          id: string;
          name: string;
          slug: string;
          description: string | null;
          inputSchema: unknown;
        }>;
      }
    >();

    for (const fn of apFunctions) {
      // Extract piece name from pluginId (activepieces-{pieceName})
      const pieceName = fn.pluginId.replace("activepieces-", "");

      if (!pieceMap.has(pieceName)) {
        pieceMap.set(pieceName, {
          name: pieceName,
          displayName: formatDisplayName(pieceName),
          actions: [],
        });
      }

      pieceMap.get(pieceName)!.actions.push({
        id: fn.id,
        name: fn.name,
        slug: fn.slug,
        description: fn.description,
        inputSchema: fn.inputSchema,
      });
    }

    // Convert to array and sort by display name
    const pieces = Array.from(pieceMap.values()).sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    );

    return NextResponse.json({
      success: true,
      pieces,
      totalPieces: pieces.length,
      totalActions: apFunctions.length,
    });
  } catch (error) {
    console.error("[ActivePieces API] Error fetching pieces:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * Format a piece name as a display name
 * e.g., "google-sheets" -> "Google Sheets"
 */
function formatDisplayName(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * ActivePieces Health Check API
 *
 * GET /api/activepieces/health - Check ActivePieces connectivity
 *
 * Verifies that the ActivePieces instance is reachable and returns
 * basic information about available pieces.
 */
import { NextResponse } from "next/server";
import { getActivePiecesClient } from "@/lib/activepieces/client";
import { db } from "@/lib/db";
import { functions } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

const ACTIVEPIECES_URL =
  process.env.ACTIVEPIECES_URL || "https://activepieces.cnoe.localtest.me:8443";

export async function GET() {
  try {
    // Check database for seeded AP functions
    const dbResult = await db.execute<{ count: number }>(sql`
      SELECT COUNT(*) as count FROM functions WHERE slug LIKE 'ap-%'
    `);
    const seededCount = Number(dbResult[0]?.count || 0);

    // Try to reach ActivePieces
    const client = getActivePiecesClient({ baseUrl: ACTIVEPIECES_URL });
    let apReachable = false;
    let apPieceCount = 0;

    try {
      apReachable = await client.healthCheck();
      if (apReachable) {
        const pieces = await client.listPieces();
        apPieceCount = pieces.length;
      }
    } catch {
      // AP not reachable - this is OK, we can still use seeded functions
    }

    return NextResponse.json({
      success: true,
      activepieces: {
        url: ACTIVEPIECES_URL,
        reachable: apReachable,
        pieceCount: apPieceCount,
      },
      database: {
        seededFunctions: seededCount,
        seededPieces: await countSeededPieces(),
      },
      status: seededCount > 0 || apReachable ? "healthy" : "no_data",
    });
  } catch (error) {
    console.error("[ActivePieces Health] Error:", error);

    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        status: "error",
      },
      { status: 500 }
    );
  }
}

/**
 * Count unique pieces in the database
 */
async function countSeededPieces(): Promise<number> {
  const result = await db.execute<{ count: number }>(sql`
    SELECT COUNT(DISTINCT plugin_id) as count
    FROM functions
    WHERE slug LIKE 'ap-%'
  `);
  return Number(result[0]?.count || 0);
}

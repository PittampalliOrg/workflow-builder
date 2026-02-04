/**
 * ActivePieces Piece Details API
 *
 * GET /api/activepieces/pieces/[pieceName] - Get details for a specific piece
 *
 * Returns all actions available for a piece with their input schemas.
 */
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { functions } from "@/lib/db/schema";
import { eq, and, sql } from "drizzle-orm";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ pieceName: string }> }
) {
  try {
    const { pieceName } = await params;
    const pluginId = `activepieces-${pieceName}`;

    // Fetch all actions for this piece
    const actions = await db
      .select({
        id: functions.id,
        name: functions.name,
        slug: functions.slug,
        description: functions.description,
        version: functions.version,
        inputSchema: functions.inputSchema,
        outputSchema: functions.outputSchema,
        integrationType: functions.integrationType,
        timeoutSeconds: functions.timeoutSeconds,
      })
      .from(functions)
      .where(
        and(
          eq(functions.pluginId, pluginId),
          eq(functions.isEnabled, true)
        )
      )
      .orderBy(functions.name);

    if (actions.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: `No actions found for piece: ${pieceName}`,
        },
        { status: 404 }
      );
    }

    // Get piece metadata from first action
    const integrationType = actions[0].integrationType;

    return NextResponse.json({
      success: true,
      piece: {
        name: pieceName,
        displayName: formatDisplayName(pieceName),
        integrationType,
        actionCount: actions.length,
      },
      actions: actions.map((action) => ({
        id: action.id,
        name: action.name,
        slug: action.slug,
        description: action.description,
        version: action.version,
        inputSchema: action.inputSchema,
        outputSchema: action.outputSchema,
        timeoutSeconds: action.timeoutSeconds,
      })),
    });
  } catch (error) {
    console.error("[ActivePieces API] Error fetching piece details:", error);

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
 */
function formatDisplayName(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

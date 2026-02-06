import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getPieceMetadataByName } from "@/lib/db/piece-metadata";

export async function GET(
  request: Request,
  context: { params: Promise<{ pieceName: string }> }
) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { pieceName } = await context.params;
    const { searchParams } = new URL(request.url);
    const version = searchParams.get("version") ?? undefined;

    const piece = await getPieceMetadataByName(
      decodeURIComponent(pieceName),
      version
    );

    if (!piece) {
      return NextResponse.json({ error: "Piece not found" }, { status: 404 });
    }

    return NextResponse.json({
      ...piece,
      createdAt: piece.createdAt.toISOString(),
      updatedAt: piece.updatedAt.toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to fetch piece",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listPieceMetadata } from "@/lib/db/piece-metadata";

export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({
      headers: request.headers,
    });

    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const searchQuery = searchParams.get("searchQuery") ?? undefined;
    const categories = searchParams.getAll("categories");
    const limitRaw = searchParams.get("limit");

    const pieces = await listPieceMetadata({
      searchQuery,
      categories,
      limit: limitRaw ? Number(limitRaw) : undefined,
    });

    return NextResponse.json(
      pieces.map((piece) => ({
        ...piece,
        createdAt: piece.createdAt.toISOString(),
        updatedAt: piece.updatedAt.toISOString(),
      }))
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to list pieces",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

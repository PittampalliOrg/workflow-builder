import { NextResponse } from "next/server";
import { listPieceMetadataSummaries } from "@/lib/db/piece-metadata";

export async function GET(request: Request) {
	try {
		const { searchParams } = new URL(request.url);
		const searchQuery = searchParams.get("searchQuery") ?? undefined;
		const categories = searchParams.getAll("categories");
		const limitRaw = searchParams.get("limit");

		const pieces = await listPieceMetadataSummaries({
			searchQuery,
			categories,
			limit: limitRaw ? Number(limitRaw) : undefined,
		});

		return NextResponse.json(
			pieces.map((piece) => ({
				...piece,
				createdAt: piece.createdAt.toISOString(),
				updatedAt: piece.updatedAt.toISOString(),
			})),
		);
	} catch (error) {
		return NextResponse.json(
			{
				error: "Failed to list pieces",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}

import { NextResponse } from "next/server";
import { convertApPiecesToIntegrations } from "@/lib/activepieces/action-adapter";
import { isPieceInstalled } from "@/lib/activepieces/installed-pieces";
import { getBuiltinPieces } from "@/lib/actions/builtin-pieces";
import type { IntegrationDefinition } from "@/lib/actions/types";
import { getSession } from "@/lib/auth-helpers";
import { listPieceMetadata } from "@/lib/db/piece-metadata";

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SEARCH_LIMIT = 120;
const DEFAULT_BROWSE_LIMIT = 500;

type SearchIndexEntry = {
	piece: IntegrationDefinition;
	pieceText: string;
	actionTexts: string[];
};

type CatalogCache = {
	allPieces: IntegrationDefinition[];
	installedPieces: IntegrationDefinition[];
	allSearchIndex: SearchIndexEntry[];
	installedSearchIndex: SearchIndexEntry[];
	timestamp: number;
};

let cache: CatalogCache | null = null;

function clampLimit(raw: string | null, fallback: number): number {
	if (!raw) {
		return fallback;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

function buildSearchIndex(pieces: IntegrationDefinition[]): SearchIndexEntry[] {
	return pieces.map((piece) => ({
		piece,
		pieceText: `${piece.label} ${piece.type} ${piece.pieceName}`.toLowerCase(),
		actionTexts: piece.actions.map((action) =>
			`${action.label} ${action.slug} ${action.description ?? ""}`.toLowerCase(),
		),
	}));
}

async function getCatalog(): Promise<CatalogCache> {
	const now = Date.now();
	if (cache && now - cache.timestamp < CACHE_TTL_MS) {
		return cache;
	}

	const allMetadata = await listPieceMetadata({});
	const apPieces = convertApPiecesToIntegrations(allMetadata);
	const builtinPieces = getBuiltinPieces();
	const allPieces = [...builtinPieces, ...apPieces];
	const installedPieces = [
		...builtinPieces,
		...apPieces.filter((piece) =>
			isPieceInstalled(piece.pieceName || piece.type),
		),
	];

	cache = {
		allPieces,
		installedPieces,
		allSearchIndex: buildSearchIndex(allPieces),
		installedSearchIndex: buildSearchIndex(installedPieces),
		timestamp: now,
	};
	return cache;
}

function searchPieces(
	searchIndex: SearchIndexEntry[],
	query: string,
	limit: number,
): IntegrationDefinition[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) {
		return [];
	}

	const scoredMatches: Array<{
		piece: IntegrationDefinition;
		score: number;
	}> = [];

	for (const entry of searchIndex) {
		const pieceMatch = entry.pieceText.includes(normalizedQuery);
		const matchedActions = entry.piece.actions.filter((_, index) =>
			entry.actionTexts[index]?.includes(normalizedQuery),
		);

		if (!(pieceMatch || matchedActions.length > 0)) {
			continue;
		}

		const normalizedLabel = entry.piece.label.toLowerCase();
		const normalizedType = entry.piece.type.toLowerCase();
		const exactPieceMatch =
			normalizedLabel === normalizedQuery || normalizedType === normalizedQuery;
		const prefixPieceMatch =
			normalizedLabel.startsWith(normalizedQuery) ||
			normalizedType.startsWith(normalizedQuery);

		scoredMatches.push({
			piece: {
				...entry.piece,
				actions:
					matchedActions.length > 0 ? matchedActions : entry.piece.actions,
			},
			score:
				(exactPieceMatch ? 4000 : 0) +
				(prefixPieceMatch ? 2000 : 0) +
				(pieceMatch ? 1000 : 0) +
				matchedActions.length,
		});
	}

	scoredMatches.sort((a, b) => {
		if (a.score !== b.score) {
			return b.score - a.score;
		}
		return a.piece.label.localeCompare(b.piece.label);
	});

	return scoredMatches.slice(0, limit).map(({ piece }) => piece);
}

/**
 * GET /api/pieces/actions
 *
 * - Default (no query): return installed pieces only (fast browse payload).
 * - With searchQuery: searches installed pieces by default (or all pieces when scope=all).
 */
export async function GET(request: Request) {
	try {
		const session = await getSession(request);

		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { searchParams } = new URL(request.url);
		const searchQuery = searchParams.get("searchQuery")?.trim() || "";
		const scope = searchParams.get("scope") || "installed";
		const limit = clampLimit(
			searchParams.get("limit"),
			searchQuery ? DEFAULT_SEARCH_LIMIT : DEFAULT_BROWSE_LIMIT,
		);

		const catalog = await getCatalog();

		if (searchQuery) {
			const searchIndex =
				scope === "all" ? catalog.allSearchIndex : catalog.installedSearchIndex;
			const pieces = searchPieces(searchIndex, searchQuery, limit);
			return NextResponse.json({ pieces });
		}

		const base = scope === "all" ? catalog.allPieces : catalog.installedPieces;
		return NextResponse.json({ pieces: base.slice(0, limit) });
	} catch (error) {
		return NextResponse.json(
			{
				error: "Failed to load piece actions",
				details: error instanceof Error ? error.message : "Unknown error",
			},
			{ status: 500 },
		);
	}
}

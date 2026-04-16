import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { appConnections, pieceMetadata } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';
import { encryptObject } from '$lib/server/security/encryption';
import { AppConnectionStatus } from '$lib/server/types/app-connection';
import { generateId } from '$lib/server/utils/id';
import { connectionBelongsToProject } from '$lib/server/app-connection-scope';
import { requireSessionProjectId } from '$lib/server/mcp-connections';

type PieceInfo = {
	name: string;
	displayName: string;
	logoUrl: string;
	categories: string[];
};

function normalizePieceName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^@activepieces\/piece-/, '')
		.replace(/[_\s]+/g, '-')
		.replace(/-+/g, '-');
}

function expandPieceNameCandidates(value: string): string[] {
	const normalized = normalizePieceName(value);
	const raw = value.trim();
	const candidates = new Set([normalized, raw]);
	if (raw.startsWith('@activepieces/piece-')) {
		candidates.add(raw.slice('@activepieces/piece-'.length));
	} else if (normalized) {
		candidates.add(`@activepieces/piece-${normalized}`);
	}
	return Array.from(candidates).filter(Boolean);
}

function humanizePieceName(value: string): string {
	return value
		.replace(/^@activepieces\/piece-/, '')
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function matchesPieceFilter(connectionPieceName: string, filter: string, piece?: PieceInfo): boolean {
	const normalizedFilter = filter.trim().toLowerCase();
	if (!normalizedFilter) return true;

	const candidates = expandPieceNameCandidates(connectionPieceName).map((item) => item.toLowerCase());
	if (candidates.some((candidate) => candidate === normalizedFilter || candidate.includes(normalizedFilter))) {
		return true;
	}

	if (piece) {
		const providerCandidates = [
			piece.name,
			piece.displayName,
			...piece.categories,
		]
			.map((item) => item.toLowerCase())
			.filter(Boolean);
		return providerCandidates.some(
			(candidate) => candidate === normalizedFilter || candidate.includes(normalizedFilter),
		);
	}

	return false;
}

/**
 * GET /api/app-connections
 *
 * List all app connections (without encrypted values).
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	const projectId = requireSessionProjectId(locals);
	if (!db) return json([]);

	const pieceNameFilter = url.searchParams.get('pieceName')?.trim() || '';
	const providerFilter =
		url.searchParams.get('provider')?.trim() ||
		url.searchParams.get('providerId')?.trim() ||
		'';

	const [connections, pieces] = await Promise.all([
		db
			.select({
				id: appConnections.id,
				externalId: appConnections.externalId,
				pieceName: appConnections.pieceName,
				displayName: appConnections.displayName,
				type: appConnections.type,
				status: appConnections.status,
				projectIds: appConnections.projectIds,
				createdAt: appConnections.createdAt
			})
			.from(appConnections)
			.orderBy(desc(appConnections.createdAt)),
		db
			.selectDistinctOn([pieceMetadata.name], {
				name: pieceMetadata.name,
				displayName: pieceMetadata.displayName,
				logoUrl: pieceMetadata.logoUrl,
				categories: pieceMetadata.categories
			})
			.from(pieceMetadata)
			.orderBy(pieceMetadata.name, desc(pieceMetadata.updatedAt))
	]);

	const pieceMap = new Map<string, PieceInfo>();
	for (const piece of pieces) {
		const info: PieceInfo = {
			name: piece.name,
			displayName: piece.displayName,
			logoUrl: piece.logoUrl,
			categories: Array.isArray(piece.categories) ? piece.categories : []
		};
		for (const candidate of expandPieceNameCandidates(piece.name)) {
			pieceMap.set(candidate.toLowerCase(), info);
		}
		pieceMap.set(normalizePieceName(piece.name), info);
		pieceMap.set(piece.name.toLowerCase(), info);
		pieceMap.set(piece.displayName.toLowerCase(), info);
	}

	const result = connections
		.filter((connection) => connectionBelongsToProject(connection.projectIds, projectId))
		.map((connection) => {
			const normalizedPieceName = normalizePieceName(connection.pieceName);
			const piece =
				pieceMap.get(connection.pieceName.toLowerCase()) ??
				pieceMap.get(normalizedPieceName) ??
				pieceMap.get(expandPieceNameCandidates(connection.pieceName)[0]?.toLowerCase() || '');
			return {
				id: connection.id,
				externalId: connection.externalId,
				pieceName: connection.pieceName,
				displayName: connection.displayName,
				type: connection.type,
				status: connection.status,
				createdAt: connection.createdAt,
				providerId: piece?.name ? normalizePieceName(piece.name) : normalizedPieceName,
				providerLabel: piece?.displayName || humanizePieceName(connection.pieceName),
				providerIconUrl: piece?.logoUrl || null,
				category: piece?.categories?.[0] || null
			};
		})
		.filter((connection) =>
			matchesPieceFilter(connection.pieceName, pieceNameFilter, pieceMap.get(normalizePieceName(connection.pieceName))) &&
			matchesPieceFilter(connection.pieceName, providerFilter, pieceMap.get(normalizePieceName(connection.pieceName)))
		);

	return json(result);
};

/**
 * POST /api/app-connections
 *
 * Create a new app connection. Currently supports SECRET_TEXT type.
 * Encrypts the value before storing.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	const projectId = requireSessionProjectId(locals);
	if (!db) return error(503, 'Database not configured');

	const body = await request.json();
	const { pieceName, displayName, type, value } = body;

	if (!pieceName || !displayName || !type) {
		return error(400, { message: 'pieceName, displayName, and type are required' });
	}

	if (type === 'SECRET_TEXT' && !value) {
		return error(400, { message: 'value is required for SECRET_TEXT connections' });
	}

	// Encrypt the connection value
	const encryptedValue = encryptObject(
		typeof value === 'string' ? { secret_text: value } : value
	);

	const id = generateId();
	const externalId = `conn_${id}`;

	const [connection] = await db
		.insert(appConnections)
		.values({
			id,
			externalId,
			pieceName,
			displayName,
			type,
			status: AppConnectionStatus.ACTIVE,
			value: encryptedValue,
			pieceVersion: '0.0.0',
			projectIds: [projectId]
		})
		.returning({
			id: appConnections.id,
			externalId: appConnections.externalId,
			pieceName: appConnections.pieceName,
			displayName: appConnections.displayName,
			type: appConnections.type,
			status: appConnections.status,
			createdAt: appConnections.createdAt
		});

	return json(connection, { status: 201 });
};

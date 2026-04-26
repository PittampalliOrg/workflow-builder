import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { appConnections, pieceMetadata } from '$lib/server/db/schema';
import { desc } from 'drizzle-orm';
import { encryptObject } from '$lib/server/security/encryption';
import {
	AppConnectionScope,
	AppConnectionStatus,
	AppConnectionType
} from '$lib/server/types/app-connection';
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
	const searchFilter =
		url.searchParams.get('q')?.trim() ||
		url.searchParams.get('search')?.trim() ||
		url.searchParams.get('displayName')?.trim() ||
		'';
	const statusFilter = url.searchParams.get('status')?.trim().toUpperCase() || '';
	const typeFilter = url.searchParams.get('type')?.trim().toUpperCase() || '';
	const scopeFilter = url.searchParams.get('scope')?.trim().toUpperCase() || '';

	const [connections, pieces] = await Promise.all([
		db
			.select({
				id: appConnections.id,
				externalId: appConnections.externalId,
				pieceName: appConnections.pieceName,
				displayName: appConnections.displayName,
				type: appConnections.type,
				status: appConnections.status,
				scope: appConnections.scope,
				ownerId: appConnections.ownerId,
				platformId: appConnections.platformId,
				projectIds: appConnections.projectIds,
				createdAt: appConnections.createdAt,
				updatedAt: appConnections.updatedAt
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
				scope: connection.scope,
				ownerId: connection.ownerId,
				platformId: connection.platformId,
				createdAt: connection.createdAt,
				updatedAt: connection.updatedAt,
				providerId: piece?.name ? normalizePieceName(piece.name) : normalizedPieceName,
				providerLabel: piece?.displayName || humanizePieceName(connection.pieceName),
				providerIconUrl: piece?.logoUrl || null,
				category: piece?.categories?.[0] || null
			};
		})
		.filter((connection) =>
			matchesPieceFilter(connection.pieceName, pieceNameFilter, pieceMap.get(normalizePieceName(connection.pieceName))) &&
			matchesPieceFilter(connection.pieceName, providerFilter, pieceMap.get(normalizePieceName(connection.pieceName))) &&
			(!statusFilter || connection.status === statusFilter) &&
			(!typeFilter || connection.type === typeFilter) &&
			(!scopeFilter || connection.scope === scopeFilter) &&
			(!searchFilter ||
				[
					connection.displayName,
					connection.pieceName,
					connection.providerId,
					connection.providerLabel,
					connection.category || ''
				]
					.join(' ')
					.toLowerCase()
					.includes(searchFilter.toLowerCase()))
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

	const normalizedType = String(type).toUpperCase() as AppConnectionType;
	const supportedTypes = new Set<string>(Object.values(AppConnectionType));
	if (!supportedTypes.has(normalizedType)) {
		return error(400, { message: `Unsupported connection type: ${type}` });
	}

	if (normalizedType === AppConnectionType.SECRET_TEXT && !value) {
		return error(400, { message: 'value is required for SECRET_TEXT connections' });
	}

	const isOAuth =
		normalizedType === AppConnectionType.OAUTH2 ||
		normalizedType === AppConnectionType.PLATFORM_OAUTH2 ||
		normalizedType === AppConnectionType.CLOUD_OAUTH2;
	const rawValue =
		value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: typeof value === 'string'
				? { secret_text: value }
				: {};
	const encryptedValue = encryptObject({
		type: normalizedType,
		...rawValue
	});

	const id = generateId();
	const externalId = `conn_${id}`;
	const scope =
		body.scope === AppConnectionScope.PLATFORM
			? AppConnectionScope.PLATFORM
			: AppConnectionScope.PROJECT;

	const [connection] = await db
		.insert(appConnections)
		.values({
			id,
			externalId,
			pieceName: String(pieceName),
			displayName: String(displayName).trim(),
			type: normalizedType,
			status: isOAuth ? AppConnectionStatus.MISSING : AppConnectionStatus.ACTIVE,
			value: encryptedValue,
			pieceVersion: '0.0.0',
			projectIds: [projectId],
			ownerId: locals.session?.userId ?? null,
			platformId: locals.session?.platformId ?? null,
			scope
		})
		.returning({
			id: appConnections.id,
			externalId: appConnections.externalId,
			pieceName: appConnections.pieceName,
			displayName: appConnections.displayName,
			type: appConnections.type,
			status: appConnections.status,
			scope: appConnections.scope,
			createdAt: appConnections.createdAt,
			updatedAt: appConnections.updatedAt
		});

	return json(connection, { status: 201 });
};

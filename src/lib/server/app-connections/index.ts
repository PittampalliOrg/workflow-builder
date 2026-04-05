import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { appConnections, pieceMetadata } from '$lib/server/db/schema';
import { decryptObject, type EncryptedObject } from '$lib/server/security/encryption';

export interface AppConnectionSummary {
	id: string;
	externalId: string;
	pieceName: string;
	displayName: string;
	type: string;
	status: string;
	createdAt: Date;
	pieceDisplayName?: string | null;
	pieceLogoUrl?: string | null;
}

export interface DecryptedAppConnection {
	id: string;
	externalId: string;
	pieceName: string;
	displayName: string;
	type: string;
	status: string;
	value: Record<string, unknown>;
}

export function normalizePieceName(value: string | null | undefined): string {
	if (!value) return '';
	const trimmed = value.trim();
	return trimmed.startsWith('@activepieces/piece-')
		? trimmed.slice('@activepieces/piece-'.length)
		: trimmed;
}

function expandPieceNameCandidates(pieceName?: string | null): string[] {
	const normalized = normalizePieceName(pieceName);
	if (!normalized) return [];
	return Array.from(
		new Set([normalized, `@activepieces/piece-${normalized}`]),
	);
}

async function loadPieceMetadataMap(pieceNames: string[]): Promise<Map<string, { displayName: string | null; logoUrl: string | null }>> {
	const normalizedNames = Array.from(
		new Set(pieceNames.map((value) => normalizePieceName(value)).filter(Boolean)),
	);
	if (!db || normalizedNames.length === 0) return new Map();

	const rows = await db
		.selectDistinctOn([pieceMetadata.name], {
			name: pieceMetadata.name,
			displayName: pieceMetadata.displayName,
			logoUrl: pieceMetadata.logoUrl,
		})
		.from(pieceMetadata)
		.orderBy(pieceMetadata.name, pieceMetadata.updatedAt);

	const lookup = new Map<string, { displayName: string | null; logoUrl: string | null }>();
	for (const row of rows) {
		if (!normalizedNames.includes(row.name)) continue;
		lookup.set(row.name, {
			displayName: row.displayName ?? null,
			logoUrl: row.logoUrl ?? null,
		});
	}
	return lookup;
}

export async function listAppConnections(options?: {
	pieceName?: string | null;
	providerId?: string | null;
}): Promise<AppConnectionSummary[]> {
	if (!db) return [];

	const pieceNameFilter = options?.pieceName || options?.providerId || null;
	const candidates = expandPieceNameCandidates(pieceNameFilter);

	const rows = await db
		.select({
			id: appConnections.id,
			externalId: appConnections.externalId,
			pieceName: appConnections.pieceName,
			displayName: appConnections.displayName,
			type: appConnections.type,
			status: appConnections.status,
			createdAt: appConnections.createdAt,
		})
		.from(appConnections)
		.where(
			candidates.length > 0
				? inArray(appConnections.pieceName, candidates)
				: undefined,
		)
		.orderBy(desc(appConnections.createdAt));

	const pieceMap = await loadPieceMetadataMap(rows.map((row) => row.pieceName));
	return rows.map((row) => {
		const meta = pieceMap.get(normalizePieceName(row.pieceName));
		return {
			...row,
			pieceDisplayName: meta?.displayName ?? null,
			pieceLogoUrl: meta?.logoUrl ?? null,
		};
	});
}

export async function getDecryptedAppConnection(
	externalId: string,
): Promise<DecryptedAppConnection | null> {
	if (!db) return null;

	const [connection] = await db
		.select()
		.from(appConnections)
		.where(eq(appConnections.externalId, externalId))
		.limit(1);

	if (!connection) return null;

	return {
		id: connection.id,
		externalId: connection.externalId,
		pieceName: connection.pieceName,
		displayName: connection.displayName,
		type: connection.type,
		status: connection.status,
		value: decryptObject(connection.value as EncryptedObject),
	};
}

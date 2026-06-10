import { error } from '@sveltejs/kit';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { pieceMetadata, workflowConnectionRefs, workflows } from '$lib/server/db/schema';
import {
	isOAuth2AuthType,
	pieceActionsFromMetadata,
	pieceAuthDisplayName,
	pieceAuthType,
	pieceRequiresAuth,
	type PieceMetadataAction
} from '$lib/server/mcp-catalog';
import { normalizePieceName, pieceCandidates } from '$lib/server/mcp-connections';

export type PieceDetailAction = PieceMetadataAction;

export type PieceConnectionUsage = {
	/** workflow_connection_ref rows referencing this connection (per node). */
	refCount: number;
	/** Distinct workflows referencing this connection. */
	workflowCount: number;
};

export const load: PageServerLoad = async ({ params, parent }) => {
	const { workspaceProjectId } = await parent();
	const pieceName = normalizePieceName(params.pieceName);
	if (!pieceName) throw error(404, 'Integration not found');
	if (!db) throw error(503, 'Database not available');

	const candidates = pieceCandidates(pieceName);
	const [piece] = await db
		.select({
			name: pieceMetadata.name,
			displayName: pieceMetadata.displayName,
			description: pieceMetadata.description,
			logoUrl: pieceMetadata.logoUrl,
			categories: pieceMetadata.categories,
			version: pieceMetadata.version,
			auth: pieceMetadata.auth,
			actions: pieceMetadata.actions,
			catalogSourceImage: pieceMetadata.catalogSourceImage,
			catalogSyncedAt: pieceMetadata.catalogSyncedAt,
			updatedAt: pieceMetadata.updatedAt
		})
		.from(pieceMetadata)
		.where(inArray(pieceMetadata.name, candidates))
		.orderBy(desc(pieceMetadata.updatedAt))
		.limit(1);

	if (!piece) throw error(404, 'Integration not found');

	// Usage counts: workflow_connection_ref rows per connection for this piece,
	// scoped to the workspace via the owning workflow's project_id.
	const refRows = await db
		.select({
			connectionExternalId: workflowConnectionRefs.connectionExternalId,
			workflowId: workflowConnectionRefs.workflowId
		})
		.from(workflowConnectionRefs)
		.innerJoin(workflows, eq(workflowConnectionRefs.workflowId, workflows.id))
		.where(
			and(
				inArray(workflowConnectionRefs.pieceName, candidates),
				eq(workflows.projectId, workspaceProjectId)
			)
		);

	const usageByConnection: Record<string, PieceConnectionUsage> = {};
	const workflowsByConnection = new Map<string, Set<string>>();
	for (const row of refRows) {
		const usage = (usageByConnection[row.connectionExternalId] ??= {
			refCount: 0,
			workflowCount: 0
		});
		usage.refCount += 1;
		const set = workflowsByConnection.get(row.connectionExternalId) ?? new Set<string>();
		set.add(row.workflowId);
		workflowsByConnection.set(row.connectionExternalId, set);
	}
	for (const [externalId, set] of workflowsByConnection) {
		usageByConnection[externalId].workflowCount = set.size;
	}

	const authType = pieceAuthType(piece.auth);

	return {
		piece: {
			pieceName,
			canonicalPieceName: `@activepieces/piece-${pieceName}`,
			displayName: piece.displayName,
			description: piece.description,
			logoUrl: piece.logoUrl,
			categories: piece.categories ?? [],
			version: piece.version,
			authType,
			authDisplayName: pieceAuthDisplayName(piece.auth),
			requiresAuth: pieceRequiresAuth(authType),
			isOAuth2: isOAuth2AuthType(authType),
			catalogSourceImage: piece.catalogSourceImage,
			catalogSyncedAt: piece.catalogSyncedAt?.toISOString() ?? null,
			metadataUpdatedAt: piece.updatedAt?.toISOString() ?? null
		},
		actions: pieceActionsFromMetadata(piece.actions),
		usageByConnection
	};
};

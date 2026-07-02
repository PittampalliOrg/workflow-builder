import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
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

	const candidates = pieceCandidates(pieceName);
	const { piece, usageByConnection } =
		await getApplicationAdapters().workflowData.getPieceCatalogDetail({
			pieceNameCandidates: candidates,
			projectId: workspaceProjectId
		});

	if (!piece) throw error(404, 'Integration not found');

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
			availableOnly: piece.availableOnly === true,
			catalogSourceImage: piece.catalogSourceImage,
			catalogSyncedAt: piece.catalogSyncedAt?.toISOString() ?? null,
			metadataUpdatedAt: piece.updatedAt?.toISOString() ?? null
		},
		actions: pieceActionsFromMetadata(piece.actions),
		usageByConnection
	};
};

import {
	getActionCatalogDetail,
	loadActionCatalogSnapshot,
} from "$lib/server/action-catalog";
import { PostgresCodeFunctionStore } from "$lib/server/application/adapters/code-functions";
import { PostgresPieceMetadataActionSourceReader } from "$lib/server/application/adapters/piece-metadata-action-source";
import type {
	ActionCatalogDetailReadModel,
	ActionCatalogReader,
} from "$lib/server/application/action-catalog";

export class LegacyActionCatalogReader implements ActionCatalogReader {
	constructor(
		private readonly codeFunctions = new PostgresCodeFunctionStore(),
		private readonly pieceMetadataSource = new PostgresPieceMetadataActionSourceReader(),
	) {}

	loadSnapshot(userId: string | null): Promise<unknown> {
		return loadActionCatalogSnapshot(userId, {
			codeFunctions: this.codeFunctions,
			pieceMetadataSource: this.pieceMetadataSource,
		});
	}

	async getDetail(
		actionId: string,
		userId: string | null,
	): Promise<ActionCatalogDetailReadModel | null> {
		const action = await getActionCatalogDetail(actionId, userId, {
			codeFunctions: this.codeFunctions,
			pieceMetadataSource: this.pieceMetadataSource,
		});
		return action as ActionCatalogDetailReadModel | null;
	}
}

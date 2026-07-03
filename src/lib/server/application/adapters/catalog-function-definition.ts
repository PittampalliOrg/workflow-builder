import { PostgresCodeFunctionStore } from "$lib/server/application/adapters/code-functions";
import { toCodeFunctionDefinitionFromDetail } from "$lib/server/code-functions/model";
import { PostgresPieceMetadataActionSourceReader } from "$lib/server/application/adapters/piece-metadata-action-source";
import type { CatalogFunctionDefinitionReader } from "$lib/server/application/catalog-function-definition";

export class PostgresCatalogFunctionDefinitionReader
	implements CatalogFunctionDefinitionReader
{
	constructor(
		private readonly store = new PostgresCodeFunctionStore(),
		private readonly pieceMetadataSource = new PostgresPieceMetadataActionSourceReader(),
	) {}

	async getCodeFunctionDefinition(input: {
		name: string;
		version: string;
		userId: string;
	}): Promise<Record<string, unknown> | null> {
		const detail = await this.store.getCodeFunctionBySlug(
			input.name,
			input.version,
			input.userId,
		);
		return detail
			? (toCodeFunctionDefinitionFromDetail(detail) as Record<string, unknown>)
			: null;
	}

	getPieceFunctionDefinition(
		name: string,
	): Promise<Record<string, unknown> | null> {
		return this.pieceMetadataSource.getPieceCatalogDefinition(name);
	}
}

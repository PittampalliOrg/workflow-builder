import {
	getCodeFunctionBySlug,
	toCodeFunctionDefinitionFromDetail,
} from "$lib/server/code-functions";
import { getPieceCatalogDefinition } from "$lib/server/action-catalog/piece-metadata-source";
import type { CatalogFunctionDefinitionReader } from "$lib/server/application/catalog-function-definition";

export class LegacyCatalogFunctionDefinitionReader
	implements CatalogFunctionDefinitionReader
{
	async getCodeFunctionDefinition(input: {
		name: string;
		version: string;
		userId: string;
	}): Promise<Record<string, unknown> | null> {
		const detail = await getCodeFunctionBySlug(
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
		return getPieceCatalogDefinition(name);
	}
}

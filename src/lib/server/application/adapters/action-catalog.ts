import {
	getActionCatalogDetail,
	loadActionCatalogSnapshot,
} from "$lib/server/action-catalog";
import { PostgresCodeFunctionStore } from "$lib/server/application/adapters/code-functions";
import type {
	ActionCatalogDetailReadModel,
	ActionCatalogReader,
} from "$lib/server/application/action-catalog";

export class LegacyActionCatalogReader implements ActionCatalogReader {
	constructor(private readonly codeFunctions = new PostgresCodeFunctionStore()) {}

	loadSnapshot(userId: string | null): Promise<unknown> {
		return loadActionCatalogSnapshot(userId, {
			codeFunctions: this.codeFunctions,
		});
	}

	async getDetail(
		actionId: string,
		userId: string | null,
	): Promise<ActionCatalogDetailReadModel | null> {
		const action = await getActionCatalogDetail(actionId, userId, {
			codeFunctions: this.codeFunctions,
		});
		return action as ActionCatalogDetailReadModel | null;
	}
}

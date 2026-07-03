import {
	getActionCatalogDetail,
	loadActionCatalogSnapshot,
} from "$lib/server/action-catalog";
import type {
	ActionCatalogDetailReadModel,
	ActionCatalogReader,
} from "$lib/server/application/action-catalog";

export class LegacyActionCatalogReader implements ActionCatalogReader {
	loadSnapshot(userId: string | null): Promise<unknown> {
		return loadActionCatalogSnapshot(userId);
	}

	async getDetail(
		actionId: string,
		userId: string | null,
	): Promise<ActionCatalogDetailReadModel | null> {
		const action = await getActionCatalogDetail(actionId, userId);
		return action as ActionCatalogDetailReadModel | null;
	}
}

import { and, asc, eq } from "drizzle-orm";
import { db } from "./index";
import { modelCatalog, modelProviders } from "./schema";

export type ModelCatalogItem = {
	id: string;
	provider: string;
	providerName: string;
	iconKey: string;
	modelKey: string;
	displayName: string;
	description: string | null;
	fullModelId: string;
};

export async function listModelCatalog(params?: {
	includeDisabled?: boolean;
}): Promise<ModelCatalogItem[]> {
	const includeDisabled = params?.includeDisabled ?? false;
	const whereCondition = includeDisabled
		? undefined
		: and(eq(modelCatalog.isEnabled, true), eq(modelProviders.isEnabled, true));

	const rows = await db
		.select({
			id: modelCatalog.id,
			provider: modelProviders.id,
			providerName: modelProviders.name,
			iconKey: modelProviders.iconKey,
			modelKey: modelCatalog.modelKey,
			displayName: modelCatalog.displayName,
			description: modelCatalog.description,
		})
		.from(modelCatalog)
		.innerJoin(modelProviders, eq(modelCatalog.providerId, modelProviders.id))
		.where(whereCondition)
		.orderBy(
			asc(modelProviders.sortOrder),
			asc(modelProviders.name),
			asc(modelCatalog.sortOrder),
			asc(modelCatalog.displayName),
		);

	return rows.map((row) => ({
		...row,
		fullModelId: `${row.provider}/${row.modelKey}`,
	}));
}

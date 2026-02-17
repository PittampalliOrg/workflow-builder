import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth-helpers";
import { listModelCatalog } from "@/lib/db/model-catalog";
import {
	DEFAULT_MODEL_CATALOG,
	DEFAULT_MODEL_PROVIDERS,
	getProviderNameById,
} from "@/lib/models/catalog-defaults";

function buildDefaultRows() {
	const enabledProviderIds = new Set(
		DEFAULT_MODEL_PROVIDERS.map((provider) => provider.id),
	);

	return DEFAULT_MODEL_CATALOG.filter((entry) =>
		enabledProviderIds.has(entry.providerId),
	).map((entry) => ({
		id: entry.id,
		providerId: entry.providerId,
		providerName: getProviderNameById(entry.providerId),
		iconKey: entry.providerId,
		modelKey: entry.modelKey,
		modelId: `${entry.providerId}/${entry.modelKey}`,
		displayName: entry.displayName,
		description: entry.description ?? null,
	}));
}

export async function GET(request: Request) {
	try {
		const session = await getSession(request);
		if (!session?.user) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const rows = await listModelCatalog({ includeDisabled: false });
		if (rows.length === 0) {
			return NextResponse.json({ data: buildDefaultRows() });
		}

		return NextResponse.json({
			data: rows.map((row) => ({
				id: row.id,
				providerId: row.provider,
				providerName: row.providerName,
				iconKey: row.iconKey,
				modelKey: row.modelKey,
				modelId: row.fullModelId,
				displayName: row.displayName,
				description: row.description,
			})),
		});
	} catch (error) {
		console.error("[resources/models] GET error:", error);
		return NextResponse.json({ data: buildDefaultRows() });
	}
}

import { convertApPiecesToIntegrations } from "@/lib/activepieces/action-adapter";
import { isPieceInstalled } from "@/lib/activepieces/installed-pieces";
import { getBuiltinPieces } from "@/lib/actions/builtin-pieces";
import { listPieceMetadata } from "@/lib/db/piece-metadata";
import type { ActionDefinition } from "@/lib/actions/types";
import "@/plugins/index";
import { getAllActions, getIntegrationLabels } from "@/plugins/registry";
import { buildCatalogFromIntegrations } from "./catalog";
import type { WorkflowSpecCatalog } from "./catalog";

export async function loadInstalledWorkflowSpecCatalog(): Promise<WorkflowSpecCatalog> {
	const allMetadata = await listPieceMetadata({});
	const apPieces = convertApPiecesToIntegrations(allMetadata).filter((piece) =>
		isPieceInstalled(piece.pieceName || piece.type),
	);
	const builtinPieces = getBuiltinPieces();

	const catalog = buildCatalogFromIntegrations([...builtinPieces, ...apPieces]);

	// Merge plugin registry actions (plugins/*) so lint accepts function slugs like slack/send-message.
	for (const action of getAllActions()) {
		const mapped: ActionDefinition = {
			id: action.id,
			integration: action.integration,
			slug: action.slug,
			label: action.label,
			description: action.description,
			category: action.category,
			configFields: action.configFields as any,
			outputFields: action.outputFields as any,
			outputConfig: action.outputConfig as any,
		};
		catalog.actionsById.set(action.id, mapped);
	}

	Object.assign(catalog.integrationLabels, getIntegrationLabels());

	return catalog;
}

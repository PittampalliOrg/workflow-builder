import type {
	ActionDefinition,
	IntegrationDefinition,
} from "@/lib/actions/types";
import { computeActionId } from "@/lib/actions/utils";

export type WorkflowSpecCatalog = {
	integrations: IntegrationDefinition[];
	actionsById: Map<string, ActionDefinition>;
	integrationLabels: Record<string, string>;
};

export function buildCatalogFromIntegrations(
	integrations: IntegrationDefinition[],
): WorkflowSpecCatalog {
	const actionsById = new Map<string, ActionDefinition>();
	const integrationLabels: Record<string, string> = {};

	for (const piece of integrations) {
		integrationLabels[piece.type] = piece.label;
		for (const action of piece.actions) {
			const id = computeActionId(piece.type, action.slug);
			actionsById.set(id, {
				...action,
				id,
				integration: piece.type,
			});
		}
	}

	return { integrations, actionsById, integrationLabels };
}

/**
 * Dapr Workflow Activity Registration for Activepieces Pieces
 *
 * Auto-discovers all installed AP pieces and their actions, then registers
 * each as a named Dapr workflow activity. Activities execute in-process
 * using the same executeAction() path as the HTTP /execute endpoint.
 */

import { WorkflowRuntime, type WorkflowActivityContext } from "@dapr/dapr";
import { PIECES } from "./piece-registry.js";
import { executeAction } from "./executor.js";

export interface ApActivityMeta {
	name: string;
	displayName: string;
	description: string;
	pieceName: string;
	actionName: string;
}

interface ApActivityPayload {
	input: Record<string, unknown>;
	credentials_raw?: unknown;
	credentials?: Record<string, string>;
	execution_id: string;
	workflow_id: string;
	node_id: string;
}

/**
 * Register a Dapr activity for every action in every installed AP piece.
 * Returns metadata for the introspect endpoint.
 */
export function registerPieceActivities(
	runtime: WorkflowRuntime,
): ApActivityMeta[] {
	const registered: ApActivityMeta[] = [];

	for (const [pieceName, piece] of Object.entries(PIECES)) {
		let actions: Record<string, { name: string; displayName: string; description: string }>;
		try {
			actions = piece.actions() as Record<string, { name: string; displayName: string; description: string }>;
		} catch {
			console.warn(`[dapr-activities] Failed to get actions for piece: ${pieceName}`);
			continue;
		}

		for (const [actionName, action] of Object.entries(actions)) {
			const safePiece = pieceName.replace(/-/g, "_");
			const safeAction = actionName.replace(/-/g, "_");
			const activityName = `ap_${safePiece}_${safeAction}`;

			const handler = async (
				_ctx: WorkflowActivityContext,
				payload: ApActivityPayload,
			) => {
				return executeAction({
					step: `${pieceName}/${actionName}`,
					execution_id: payload.execution_id,
					workflow_id: payload.workflow_id,
					node_id: payload.node_id,
					input: payload.input,
					credentials_raw: payload.credentials_raw,
					credentials: payload.credentials,
					metadata: { pieceName, actionName },
				});
			};

			// Dapr SDK uses Function.name for activity identification
			Object.defineProperty(handler, "name", { value: activityName });

			runtime.registerActivity(handler);

			registered.push({
				name: activityName,
				displayName: action.displayName || actionName,
				description: action.description || "",
				pieceName,
				actionName,
			});
		}
	}

	return registered;
}

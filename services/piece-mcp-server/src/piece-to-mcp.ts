/**
 * Piece-to-MCP Registration
 *
 * Core module: loads an AP piece, reads its metadata from the DB,
 * and registers all actions as MCP tools on a Server instance.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Piece } from "@activepieces/pieces-framework";
import { actionPropsToSchema } from "./prop-schema.js";
import { normalizeActionInput } from "./normalize-input.js";
import { buildActionContext } from "./context-factory.js";
import { resolveAuth } from "./auth-resolver.js";

/** Shape of a single action definition from piece_metadata.actions JSONB. */
type ActionDef = {
	name: string;
	displayName?: string;
	description?: string;
	props?: Record<string, unknown>;
	requireAuth?: boolean;
};

/** Piece metadata row from DB. */
export type PieceMetadataRow = {
	actions: Record<string, ActionDef> | null;
	auth: unknown;
	displayName: string | null;
};

/** Registered tool info for health reporting. */
export type RegisteredTool = {
	name: string;
	description: string;
};

/**
 * Register all actions from an AP piece as MCP tools on the given Server.
 *
 * Returns the list of registered tools (for health endpoint reporting).
 */
export function registerPieceTools(
	server: Server,
	piece: Piece,
	metadata: PieceMetadataRow,
): RegisteredTool[] {
	const actions = metadata.actions ?? {};
	const registeredTools: RegisteredTool[] = [];

	// Build the tool definitions list for ListTools
	const toolDefs: Array<{
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
	}> = [];

	// Map of tool name → handler info
	const toolHandlers = new Map<
		string,
		{
			requireAuth: boolean;
		}
	>();

	for (const [actionKey, actionDef] of Object.entries(actions)) {
		// Get runtime action from the piece
		const action = piece.getAction(actionKey);
		if (!action) {
			console.warn(
				`[piece-mcp] Skipping action "${actionKey}" — not found in piece runtime`,
			);
			continue;
		}

		// Build description
		const displayName = actionDef.displayName || actionKey;
		const description = actionDef.description
			? `${displayName}: ${actionDef.description}`
			: displayName;

		// Convert props to JSON Schema
		const props = (actionDef.props ?? {}) as Record<string, Record<string, unknown>>;
		const inputSchema = actionPropsToSchema(props);

		toolDefs.push({
			name: actionKey,
			description,
			inputSchema,
		});

		toolHandlers.set(actionKey, {
			requireAuth: actionDef.requireAuth !== false,
		});

		registeredTools.push({ name: actionKey, description });
	}

	// Register ListTools handler
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: toolDefs,
	}));

	// Register CallTool handler
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;

		const handler = toolHandlers.get(name);
		if (!handler) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Unknown tool: ${name}. Available tools: ${[...toolHandlers.keys()].join(", ")}`,
					},
				],
				isError: true,
			};
		}

		const { requireAuth } = handler;

		try {
			// Resolve auth if needed
			let auth: unknown = undefined;
			if (requireAuth) {
				auth = await resolveAuth();
				if (auth == null) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Missing credentials for "${name}". Set CONNECTION_EXTERNAL_ID or CREDENTIALS_JSON env var.`,
							},
						],
						isError: true,
					};
				}
			}

			// Re-fetch action from piece (guaranteed non-null since we verified at registration)
			const runtimeAction = piece.getAction(name)!;

			// Normalize input (unwrap dropdowns, etc.)
			const inputArgs = (args ?? {}) as Record<string, unknown>;
			const normalizedInput = normalizeActionInput(runtimeAction, inputArgs);

			// Build AP execution context
			const executionId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			const { context } = buildActionContext({
				auth,
				propsValue: normalizedInput,
				executionId,
				actionName: name,
			});

			// Execute the action
			const result = await runtimeAction.run(context);

			// Format result as MCP text content
			const resultText =
				typeof result === "string"
					? result
					: JSON.stringify(result, null, 2);

			return {
				content: [{ type: "text" as const, text: resultText }],
			};
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			console.error(`[piece-mcp] Tool "${name}" failed:`, error);
			return {
				content: [
					{
						type: "text" as const,
						text: `Action "${name}" failed: ${message}`,
					},
				],
				isError: true,
			};
		}
	});

	return registeredTools;
}

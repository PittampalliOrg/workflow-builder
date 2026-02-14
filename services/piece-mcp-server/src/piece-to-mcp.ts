/**
 * Piece-to-MCP Registration
 *
 * Core module: loads an AP piece, reads its metadata from the DB,
 * and registers all actions as MCP tools on a Server instance.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
	registerAppResource,
	RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import type { Piece } from "@activepieces/pieces-framework";
import { actionPropsToSchema, type JsonSchema } from "./prop-schema.js";
import { normalizeActionInput } from "./normalize-input.js";
import { buildActionContext } from "./context-factory.js";
import { resolveAuth } from "./auth-resolver.js";

/**
 * Convert a JSON Schema object to a Zod raw shape for use with McpServer.registerTool().
 * Maps each property to a basic Zod type. This allows the MCP SDK to validate inputs.
 */
function jsonSchemaToZodShape(
	schema: JsonSchema,
): Record<string, z.ZodTypeAny> {
	const shape: Record<string, z.ZodTypeAny> = {};
	const requiredSet = new Set(schema.required ?? []);

	for (const [key, prop] of Object.entries(schema.properties)) {
		let zodType: z.ZodTypeAny;

		switch (prop.type) {
			case "number":
				zodType = z.number();
				break;
			case "boolean":
				zodType = z.boolean();
				break;
			case "array":
				zodType = z.array(z.any());
				break;
			case "object":
				zodType = z.record(z.any());
				break;
			default:
				zodType = z.string();
		}

		if (prop.description) {
			zodType = zodType.describe(prop.description);
		}

		if (!requiredSet.has(key)) {
			zodType = zodType.optional();
		}

		shape[key] = zodType;
	}

	return shape;
}

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
		const props = (actionDef.props ?? {}) as Record<
			string,
			Record<string, unknown>
		>;
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
			let auth: unknown;
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
				typeof result === "string" ? result : JSON.stringify(result, null, 2);

			return {
				content: [{ type: "text" as const, text: resultText }],
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
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

/**
 * Register all actions from an AP piece as MCP App tools on an McpServer,
 * with a shared UI resource. Used when an HTML UI file exists for the piece.
 *
 * Returns the list of registered tools (for health endpoint reporting).
 */
export function registerPieceToolsWithUI(
	server: McpServer,
	piece: Piece,
	metadata: PieceMetadataRow,
	uiHtmlPath: string,
	pieceName: string,
): RegisteredTool[] {
	const fs = require("fs") as typeof import("fs");
	const htmlContent = fs.readFileSync(uiHtmlPath, "utf-8");

	const resourceUri = `ui://piece-mcp-${pieceName}/app.html`;

	// Register the shared UI resource (name, uri, config, callback)
	registerAppResource(
		server,
		`${pieceName} UI`,
		resourceUri,
		{ mimeType: RESOURCE_MIME_TYPE },
		async () => ({
			contents: [
				{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: htmlContent },
			],
		}),
	);

	const actions = metadata.actions ?? {};
	const registeredTools: RegisteredTool[] = [];

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

		// Convert props to JSON Schema, then to Zod shape
		const props = (actionDef.props ?? {}) as Record<
			string,
			Record<string, unknown>
		>;
		const jsonSchema = actionPropsToSchema(props);
		const zodShape = jsonSchemaToZodShape(jsonSchema);

		// Register as an MCP App tool with UI metadata using server.registerTool directly
		// (registerAppTool expects Zod shapes but we need to pass _meta for UI)
		const uiMeta = {
			ui: { resourceUri },
			"ui/resourceUri": resourceUri,
		};

		(server as any).registerTool(
			actionKey,
			{
				title: displayName,
				description,
				// Avoid pathological type instantiation in the MCP SDK generics.
				inputSchema: zodShape as any,
				_meta: uiMeta,
			} as any,
			async (args: Record<string, unknown>) => {
				const requireAuth = actionDef.requireAuth !== false;

				try {
					let auth: unknown;
					if (requireAuth) {
						auth = await resolveAuth();
						if (auth == null) {
							return {
								content: [
									{
										type: "text" as const,
										text: `Missing credentials for "${actionKey}". Set CONNECTION_EXTERNAL_ID or CREDENTIALS_JSON env var.`,
									},
								],
								isError: true,
							};
						}
					}

					const runtimeAction = piece.getAction(actionKey)!;
					const normalizedInput = normalizeActionInput(runtimeAction, args);

					const executionId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					const { context } = buildActionContext({
						auth,
						propsValue: normalizedInput,
						executionId,
						actionName: actionKey,
					});

					const result = await runtimeAction.run(context);

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify(result, null, 2),
							},
						],
					};
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(`[piece-mcp] Tool "${actionKey}" failed:`, error);
					return {
						content: [
							{
								type: "text" as const,
								text: `Action "${actionKey}" failed: ${message}`,
							},
						],
						isError: true,
					};
				}
			},
		);

		registeredTools.push({ name: actionKey, description });
	}

	return registeredTools;
}

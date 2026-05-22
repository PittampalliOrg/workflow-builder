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
import type { Action, Piece } from "@activepieces/pieces-framework";
import { type JsonSchema } from "./prop-schema.js";
import { normalizeActionInput } from "./normalize-input.js";
import { buildActionContext } from "./context-factory.js";
import { resolveAuth } from "./auth-resolver.js";
import { extensionsFor } from "./extensions/index.js";
import { setSpanInput, setSpanOutput } from "./observability/content.js";

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
	inputSchema?: JsonSchema;
	requireAuth?: boolean;
	digest?: string;
};

/** Piece metadata row from DB. */
export type PieceMetadataRow = {
	actions: Record<string, ActionDef> | null;
	auth: unknown;
	displayName: string | null;
	catalogSchemaVersion: number | null;
	catalogDigest: string | null;
	catalogSourceImage: string | null;
	catalogSyncedAt: string | null;
};

/** Registered tool info for health reporting. */
export type RegisteredTool = {
	name: string;
	description: string;
};

function actionInputSchema(actionKey: string, actionDef: ActionDef): JsonSchema {
	const schema = actionDef.inputSchema;
	if (
		!schema ||
		schema.type !== "object" ||
		!schema.properties ||
		typeof schema.properties !== "object"
	) {
		throw new Error(
			`piece_metadata action "${actionKey}" is missing canonical inputSchema`,
		);
	}
	return schema;
}

/**
 * Register all actions from an AP piece as MCP tools on the given Server.
 *
 * Returns the list of registered tools (for health endpoint reporting).
 */
export function registerPieceTools(
	server: Server,
	piece: Piece,
	metadata: PieceMetadataRow,
	pieceName?: string,
): RegisteredTool[] {
	const actions = metadata.actions ?? {};
	const registeredTools: RegisteredTool[] = [];

	// Build the tool definitions list for ListTools
	const toolDefs: Array<{
		name: string;
		description: string;
		inputSchema: Record<string, unknown>;
	}> = [];

	// Map of tool name → handler info. `runtimeAction` is stashed here so
	// both vendored-piece actions and in-repo extension actions share the
	// same execution path in the CallTool handler below (no branching on
	// "is this an extension" at call time).
	// biome-ignore lint/suspicious/noExplicitAny: Action's generics are internal
	const toolHandlers = new Map<
		string,
		{
			requireAuth: boolean;
			runtimeAction: Action<any, any>;
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

		const inputSchema = actionInputSchema(actionKey, actionDef);

		toolDefs.push({
			name: actionKey,
			description,
			inputSchema,
		});

		toolHandlers.set(actionKey, {
			requireAuth: actionDef.requireAuth !== false,
			runtimeAction: action,
		});

		registeredTools.push({ name: actionKey, description });
	}

	// Extension actions — supplementary tools defined next to this file in
	// src/extensions/<piece-name>.ts. Registered alongside vendored actions
	// so agents see them in the same tools/list. See src/extensions/index.ts.
	if (pieceName) {
		for (const extAction of extensionsFor(pieceName)) {
			const displayName = extAction.displayName || extAction.name;
			const description = extAction.description
				? `${displayName}: ${extAction.description}`
				: displayName;
			const actionDef = actions[extAction.name];
			if (!actionDef) {
				throw new Error(
					`piece_metadata is missing extension action "${extAction.name}"`,
				);
			}
			const inputSchema = actionInputSchema(extAction.name, actionDef);

			toolDefs.push({
				name: extAction.name,
				description,
				inputSchema,
			});

			// requireAuth: true unconditionally. The Boolean(extAction.auth) check
			// was racey — when a TS ESM file imports a CJS-compiled piece, the
			// piece's `exports.oneDriveAuth = PieceAuth.OAuth2(...)` may not have
			// executed yet when our `createAction({auth: oneDriveAuth, ...})`
			// runs, leaving extAction.auth undefined even though the action
			// semantically requires auth. Every extension we register today is
			// for an authenticated piece; if that changes, add an explicit
			// `requireAuth: false` marker on the Action-like object instead.
			toolHandlers.set(extAction.name, {
				requireAuth: true,
				runtimeAction: extAction,
			});

			registeredTools.push({ name: extAction.name, description });
			console.log(
				`[piece-mcp] Registered extension tool: ${extAction.name} (piece=${pieceName})`,
			);
		}
	}

	// Register ListTools handler
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: toolDefs,
	}));

	// Register CallTool handler
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		setSpanInput({ toolName: name, input: args ?? {} });

		const handler = toolHandlers.get(name);
		if (!handler) {
			const output = {
				content: [
					{
						type: "text" as const,
						text: `Unknown tool: ${name}. Available tools: ${[...toolHandlers.keys()].join(", ")}`,
					},
				],
				isError: true,
			};
			setSpanOutput(output);
			return output;
		}

		const { requireAuth, runtimeAction } = handler;

		try {
			// Resolve auth if needed
			let auth: unknown;
			if (requireAuth) {
				auth = await resolveAuth();
				if (auth == null) {
					const output = {
						content: [
							{
								type: "text" as const,
								text: `Missing credentials for "${name}". Set X-Connection-External-Id on the MCP request.`,
							},
						],
						isError: true,
					};
					setSpanOutput(output);
					return output;
				}
			}

			// Normalize input (unwrap dropdowns, etc.)
			const inputArgs = (args ?? {}) as Record<string, unknown>;
			const normalizedInput = await normalizeActionInput(runtimeAction, inputArgs);

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
			setSpanOutput(result);

			// Format result as MCP text content
			const resultText =
				typeof result === "string" ? result : JSON.stringify(result, null, 2);

			return {
				content: [{ type: "text" as const, text: resultText }],
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[piece-mcp] Tool "${name}" failed:`, error);
			const output = {
				content: [
					{
						type: "text" as const,
						text: `Action "${name}" failed: ${message}`,
					},
				],
				isError: true,
			};
			setSpanOutput(output);
			return output;
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

		const jsonSchema = actionInputSchema(actionKey, actionDef);
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
				setSpanInput({ toolName: actionKey, input: args });

				try {
					let auth: unknown;
					if (requireAuth) {
						auth = await resolveAuth();
						if (auth == null) {
							const output = {
								content: [
									{
										type: "text" as const,
										text: `Missing credentials for "${actionKey}". Set X-Connection-External-Id on the MCP request.`,
									},
								],
								isError: true,
							};
							setSpanOutput(output);
							return output;
						}
					}

					const runtimeAction = piece.getAction(actionKey)!;
					const normalizedInput = await normalizeActionInput(runtimeAction, args);

					const executionId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					const { context } = buildActionContext({
						auth,
						propsValue: normalizedInput,
						executionId,
						actionName: actionKey,
					});

					const result = await runtimeAction.run(context);
					setSpanOutput(result);

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
					const output = {
						content: [
							{
								type: "text" as const,
								text: `Action "${actionKey}" failed: ${message}`,
							},
						],
						isError: true,
					};
					setSpanOutput(output);
					return output;
				}
			},
		);

		registeredTools.push({ name: actionKey, description });
	}

	// Extension actions for this piece — see src/extensions/.
	for (const extAction of extensionsFor(pieceName)) {
		const displayName = extAction.displayName || extAction.name;
		const description = extAction.description
			? `${displayName}: ${extAction.description}`
			: displayName;
		const actionDef = actions[extAction.name];
		if (!actionDef) {
			throw new Error(
				`piece_metadata is missing extension action "${extAction.name}"`,
			);
		}
		const jsonSchema = actionInputSchema(extAction.name, actionDef);
		const zodShape = jsonSchemaToZodShape(jsonSchema);

		const uiMeta = {
			ui: { resourceUri },
			"ui/resourceUri": resourceUri,
		};

		// biome-ignore lint/suspicious/noExplicitAny: see vendored-action registration above
		(server as any).registerTool(
			extAction.name,
			{
				title: displayName,
				description,
				// biome-ignore lint/suspicious/noExplicitAny: SDK generic pathology
				inputSchema: zodShape as any,
				_meta: uiMeta,
				// biome-ignore lint/suspicious/noExplicitAny: SDK generic pathology
			} as any,
			async (args: Record<string, unknown>) => {
				// Always require auth for extensions — see registerPieceTools for
				// the CJS-import-timing rationale.
				const requireAuth = true;
				setSpanInput({ toolName: extAction.name, input: args });
				try {
					let auth: unknown;
					if (requireAuth) {
						auth = await resolveAuth();
						if (auth == null) {
							const output = {
								content: [
									{
										type: "text" as const,
										text: `Missing credentials for "${extAction.name}". Set X-Connection-External-Id on the MCP request.`,
									},
								],
								isError: true,
							};
							setSpanOutput(output);
							return output;
						}
					}

					const normalizedInput = await normalizeActionInput(
						extAction,
						args,
					);
					const executionId = `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					const { context } = buildActionContext({
						auth,
						propsValue: normalizedInput,
						executionId,
						actionName: extAction.name,
					});
					const result = await extAction.run(context);
					setSpanOutput(result);
					return {
						content: [
							{
								type: "text" as const,
								text:
									typeof result === "string"
										? result
										: JSON.stringify(result, null, 2),
							},
						],
					};
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					console.error(
						`[piece-mcp] Extension tool "${extAction.name}" failed:`,
						error,
					);
					const output = {
						content: [
							{
								type: "text" as const,
								text: `Action "${extAction.name}" failed: ${message}`,
							},
						],
						isError: true,
					};
					setSpanOutput(output);
					return output;
				}
			},
		);

		registeredTools.push({ name: extAction.name, description });
		console.log(
			`[piece-mcp] Registered extension tool (UI): ${extAction.name} (piece=${pieceName})`,
		);
	}

	return registeredTools;
}

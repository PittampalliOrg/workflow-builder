import { convertApPiecesToIntegrations } from "@/lib/activepieces/action-adapter";
import { isPieceInstalled } from "@/lib/activepieces/installed-pieces";
import { getBuiltinPieces } from "@/lib/actions/builtin-pieces";
import type {
	ActionConfigFieldBase,
	ActionDefinition,
} from "@/lib/actions/types";
import { parseActionId } from "@/lib/actions/utils";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { functions } from "@/lib/db/schema";
import { listPieceMetadata } from "@/lib/db/piece-metadata";
import { buildCatalogFromIntegrations } from "./catalog";
import type { WorkflowSpecCatalog } from "./catalog";
import { getSystemWorkflowSpecActions } from "./system-actions";

function actionDefinitionFromFunctionRow(row: {
	slug: string;
	name: string;
	description: string | null;
	pluginId: string;
	integrationType: string | null;
	inputSchema: unknown;
	outputSchema: unknown;
}): ActionDefinition | null {
	const parsed = parseActionId(row.slug);
	if (!parsed) {
		return null;
	}

	const input = row.inputSchema as
		| { type?: unknown; properties?: Record<string, any>; required?: string[] }
		| undefined
		| null;
	const properties =
		input?.properties && typeof input.properties === "object"
			? input.properties
			: {};
	const required = Array.isArray(input?.required) ? input?.required : [];

	const configFields: ActionConfigFieldBase[] = Object.entries(properties).map(
		([key, schema]) => {
			const s = schema as {
				type?: string;
				enum?: unknown[];
				description?: string;
				minimum?: number;
				default?: unknown;
			};
			const isNumber = s.type === "number" || s.type === "integer";
			const hasEnum = Array.isArray(s.enum) && s.enum.length > 0;
			const isBoolean = s.type === "boolean";
			const isJsonLike = s.type === "object" || s.type === "array";

			if (hasEnum) {
				return {
					key,
					label: key,
					type: "select",
					required: required.includes(key),
					options: (s.enum || []).map((v) => ({
						value: String(v),
						label: String(v),
					})),
					placeholder: s.description,
					defaultValue: s.default != null ? String(s.default) : undefined,
				};
			}

			if (isBoolean) {
				return {
					key,
					label: key,
					type: "select",
					required: required.includes(key),
					options: [
						{ value: "true", label: "true" },
						{ value: "false", label: "false" },
					],
					placeholder: s.description,
					defaultValue: s.default != null ? String(s.default) : undefined,
				};
			}

			return {
				key,
				label: key,
				type: isNumber
					? "number"
					: isJsonLike
						? "template-textarea"
						: "template-input",
				required: required.includes(key),
				placeholder: s.description,
				min: typeof s.minimum === "number" ? s.minimum : undefined,
				defaultValue:
					s.default == null
						? undefined
						: typeof s.default === "string"
							? s.default
							: JSON.stringify(s.default),
			};
		},
	);

	const output = row.outputSchema as
		| { type?: unknown; properties?: Record<string, any> }
		| undefined
		| null;
	const outProps =
		output?.properties && typeof output.properties === "object"
			? output.properties
			: {};
	const outputFields = Object.keys(outProps).map((field) => ({
		field,
		description:
			typeof outProps[field]?.description === "string"
				? String(outProps[field]?.description)
				: field,
	}));

	return {
		id: row.slug,
		integration: row.integrationType || row.pluginId,
		slug: parsed.slug,
		label: row.name,
		description: row.description || "",
		category: row.pluginId,
		configFields,
		inputSchema: row.inputSchema,
		outputSchema: row.outputSchema,
		outputFields: outputFields.length > 0 ? outputFields : undefined,
	};
}

export async function loadInstalledWorkflowSpecCatalog(): Promise<WorkflowSpecCatalog> {
	const builtinPieces = getBuiltinPieces();
	let integrations = builtinPieces;

	try {
		const allMetadata = await listPieceMetadata({});
		const apPieces = convertApPiecesToIntegrations(allMetadata).filter(
			(piece) => isPieceInstalled(piece.pieceName || piece.type),
		);
		integrations = [...builtinPieces, ...apPieces];
	} catch (error) {
		console.warn(
			"[workflow-spec/catalog-server] Failed to load Activepieces catalog from DB; using builtin catalog only.",
			error instanceof Error ? error.message : error,
		);
	}

	const catalog = buildCatalogFromIntegrations(integrations);

	// Ensure system/* actions use the canonical runtime schema (independent of DB seed state).
	catalog.integrationLabels.system = "System";
	for (const action of getSystemWorkflowSpecActions()) {
		catalog.actionsById.set(action.id, action);
	}

	// Merge DB functions so actionType slugs like "slack/send-message" validate without importing plugins/*.
	let fnRows: Array<{
		slug: string;
		name: string;
		description: string | null;
		pluginId: string;
		integrationType: string | null;
		inputSchema: unknown;
		outputSchema: unknown;
	}> = [];

	try {
		fnRows = await db
			.select({
				slug: functions.slug,
				name: functions.name,
				description: functions.description,
				pluginId: functions.pluginId,
				integrationType: functions.integrationType,
				inputSchema: functions.inputSchema,
				outputSchema: functions.outputSchema,
			})
			.from(functions)
			.where(
				and(eq(functions.isEnabled, true), eq(functions.isDeprecated, false)),
			);
	} catch (error) {
		console.warn(
			"[workflow-spec/catalog-server] Failed to load functions catalog from DB; skipping DB actions.",
			error instanceof Error ? error.message : error,
		);
		return catalog;
	}

	for (const row of fnRows) {
		if (catalog.actionsById.has(row.slug)) {
			continue;
		}
		const action = actionDefinitionFromFunctionRow(row);
		if (action) {
			catalog.actionsById.set(action.id, action);
		}
	}

	return catalog;
}

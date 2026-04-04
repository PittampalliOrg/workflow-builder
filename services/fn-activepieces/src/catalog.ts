/**
 * SW 1.0 Function Catalog Generator
 *
 * Generates CNCF Serverless Workflow 1.0 function definitions from the
 * installed AP piece registry. Each piece action becomes a reusable function
 * that can be referenced in workflow `use.functions` or via a catalog endpoint.
 */

import { PIECES } from "./piece-registry.js";

const FN_ACTIVEPIECES_URL =
	process.env.FN_ACTIVEPIECES_INTERNAL_URL ||
	"http://fn-activepieces.workflow-builder.svc.cluster.local:8080";

// AP property types → JSON Schema types
const PROP_TYPE_MAP: Record<string, string> = {
	SHORT_TEXT: "string",
	LONG_TEXT: "string",
	NUMBER: "number",
	CHECKBOX: "boolean",
	DROPDOWN: "string",
	STATIC_DROPDOWN: "string",
	MULTI_SELECT_DROPDOWN: "array",
	STATIC_MULTI_SELECT_DROPDOWN: "array",
	DATE_TIME: "string",
	FILE: "string",
	OBJECT: "object",
	JSON: "object",
	ARRAY: "array",
	DYNAMIC: "object",
	CUSTOM_AUTH: "object",
	OAUTH2: "object",
	SECRET_TEXT: "string",
	BASIC_AUTH: "object",
};

interface CatalogFunction {
	name: string;
	version: string;
	pieceName: string;
	actionName: string;
	displayName: string;
	description: string;
	definition: Record<string, unknown>;
}

/**
 * Convert AP action props to a JSON Schema object.
 */
function propsToJsonSchema(
	props: Record<string, { type?: string; displayName?: string; description?: string; required?: boolean }>,
): Record<string, unknown> {
	const properties: Record<string, Record<string, unknown>> = {};
	const required: string[] = [];

	for (const [propName, prop] of Object.entries(props)) {
		const jsonType = PROP_TYPE_MAP[prop.type || ""] || "string";
		properties[propName] = {
			type: jsonType,
			...(prop.description ? { description: prop.description } : {}),
		};
		if (prop.required) {
			required.push(propName);
		}
	}

	return {
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
	};
}

/**
 * Generate a SW 1.0 function definition for an AP piece action.
 */
function generateFunctionDefinition(
	pieceName: string,
	actionName: string,
	action: { displayName: string; description: string; props?: Record<string, unknown>; requireAuth?: boolean },
): Record<string, unknown> {
	const def: Record<string, unknown> = {
		call: "http",
		with: {
			method: "post",
			endpoint: {
				uri: `${FN_ACTIVEPIECES_URL}/execute`,
			},
			body: {
				step: `${pieceName}/${actionName}`,
				metadata: {
					pieceName,
					actionName,
				},
			},
		},
	};

	// Add input schema from action props
	if (action.props && typeof action.props === "object") {
		const schema = propsToJsonSchema(
			action.props as Record<string, { type?: string; displayName?: string; description?: string; required?: boolean }>,
		);
		if (Object.keys(schema.properties as Record<string, unknown>).length > 0) {
			def.input = {
				schema: {
					format: "json",
					document: schema,
				},
			};
		}
	}

	return def;
}

/**
 * Build the full catalog of SW 1.0 function definitions from all installed AP pieces.
 */
export function buildCatalog(): CatalogFunction[] {
	const catalog: CatalogFunction[] = [];

	for (const [pieceName, piece] of Object.entries(PIECES)) {
		let actions: Record<string, { name: string; displayName: string; description: string; props?: Record<string, unknown>; requireAuth?: boolean }>;
		try {
			actions = piece.actions() as typeof actions;
		} catch {
			continue;
		}

		for (const [actionName, action] of Object.entries(actions)) {
			const fnName = `${pieceName}-${actionName}`;
			catalog.push({
				name: fnName,
				version: "1.0.0",
				pieceName,
				actionName,
				displayName: action.displayName || actionName,
				description: action.description || "",
				definition: generateFunctionDefinition(pieceName, actionName, action),
			});
		}
	}

	return catalog;
}

// Cache the catalog — it only changes at deploy time
let _catalogCache: CatalogFunction[] | null = null;

export function getCatalog(): CatalogFunction[] {
	if (!_catalogCache) {
		_catalogCache = buildCatalog();
	}
	return _catalogCache;
}

export function getCatalogFunction(name: string, version: string): CatalogFunction | undefined {
	return getCatalog().find((f) => f.name === name && f.version === version);
}

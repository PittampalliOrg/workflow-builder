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

type ActionPropOption = {
	label: string;
	value: unknown;
};

type ActionAuthMetadata = {
	required: boolean;
	displayName: string | null;
	description: string | null;
	kinds: string[];
	authType: string | null;
	connectionResourceType: string | null;
};

type ActionFieldOptionsMetadata =
	| {
			kind: "static";
			values: ActionPropOption[];
	  }
	| {
			kind: "dynamic";
			refreshers: string[];
			refreshOnSearch: boolean;
	  };

type ActionFieldMetadata = {
	name: string;
	displayName: string;
	description: string | null;
	propertyType: string;
	schemaType: string;
	required: boolean;
	defaultValue: unknown | null;
	dependsOn: string[];
	refreshers: string[];
	refreshOnSearch: boolean;
	options: ActionFieldOptionsMetadata | null;
};

interface CatalogFunction {
	name: string;
	version: string;
	pieceName: string;
	providerLabel: string;
	providerIconUrl: string | null;
	category: string | null;
	actionName: string;
	displayName: string;
	description: string;
	auth: ActionAuthMetadata | null;
	fields: ActionFieldMetadata[];
	definition: Record<string, unknown>;
}

export interface ActionMetadata {
	id: string;
	name: string;
	displayName: string;
	description: string;
	service: "fn-activepieces";
	runtime: "node-dapr-workflow";
	kind: "sw-function";
	visibility: "public-callable";
	sourceKind: "integration";
	providerId: string;
	providerLabel: string;
	providerIconUrl: string | null;
	category: string | null;
	auth: ActionAuthMetadata | null;
	fields: ActionFieldMetadata[];
	pieceName: string;
	actionName: string;
	version: string;
	registered: boolean;
	sourceCode: string | null;
	signature: {
		parameters: Array<{
			name: string;
			type: string;
			required: boolean;
			description: string | null;
		}>;
		inputSchema: Record<string, unknown> | null;
	};
	swCompatibility: {
		status: "compatible";
		reasons: string[];
		projection: {
			functionRefName: string;
			call: string;
			inputShape: string;
		};
	};
	taskConfig: Record<string, unknown>;
	definition: Record<string, unknown>;
}

function isAuthPropertyType(type?: string): boolean {
	switch (type) {
		case "OAUTH2":
		case "SECRET_TEXT":
		case "BASIC_AUTH":
		case "CUSTOM_AUTH":
		case "NO_AUTH":
			return true;
		default:
			return false;
	}
}

function humanizeLabel(value: string): string {
	return value
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join(" ");
}

function normalizeStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		: [];
}

function normalizeStaticOptions(
	options: unknown,
): ActionPropOption[] {
	if (Array.isArray(options)) {
		return options.flatMap((item) => {
			if (item && typeof item === "object" && !Array.isArray(item)) {
				const record = item as Record<string, unknown>;
				const label =
					(typeof record.label === "string" && record.label) ||
					(typeof record.displayName === "string" && record.displayName) ||
					(typeof record.name === "string" && record.name) ||
					(typeof record.title === "string" && record.title) ||
					(typeof record.value === "string" && record.value) ||
					(typeof record.id === "string" && record.id) ||
					null;
				const value =
					record.value ??
					record.id ??
					record.key ??
					record.name ??
					record.label;
				return label && value !== undefined ? [{ label, value }] : [];
			}
			if (
				typeof item === "string" ||
				typeof item === "number" ||
				typeof item === "boolean"
			) {
				return [{ label: String(item), value: item }];
			}
			return [];
		});
	}

	if (options && typeof options === "object") {
		const record = options as Record<string, unknown>;
		return normalizeStaticOptions(record.options);
	}

	return [];
}

function classifyAuthKind(auth: unknown): string | null {
	if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
	const record = auth as Record<string, unknown>;
	if ("authUrl" in record || "tokenUrl" in record || "scope" in record || "grantType" in record) {
		return "oauth2";
	}
	if ("username" in record && "password" in record) {
		return "basic-auth";
	}
	if ("props" in record) {
		return "custom-auth";
	}
	if ("secret_text" in record || "secretText" in record || "secret" in record) {
		return "secret-text";
	}
	return "unknown";
}

function summarizeAuth(pieceAuth: unknown, required: boolean): ActionAuthMetadata | null {
	if (!pieceAuth) return null;
	const authEntries = Array.isArray(pieceAuth) ? pieceAuth : [pieceAuth];
	if (authEntries.length === 0) return null;

	const first = authEntries[0];
	const firstRecord = first && typeof first === "object" && !Array.isArray(first) ? (first as Record<string, unknown>) : {};
	return {
		required,
		displayName:
			typeof firstRecord.displayName === "string" && firstRecord.displayName.trim().length > 0
				? firstRecord.displayName
				: null,
		description:
			typeof firstRecord.description === "string" && firstRecord.description.trim().length > 0
				? firstRecord.description
				: null,
		kinds: authEntries.map((entry) => classifyAuthKind(entry) || "unknown"),
		authType:
			typeof firstRecord.type === "string" && firstRecord.type.trim().length > 0
				? firstRecord.type
				: null,
		connectionResourceType:
			typeof firstRecord.type === "string" && firstRecord.type.trim().length > 0
				? firstRecord.type.toLowerCase()
				: null,
	};
}

function summarizeField(
	name: string,
	prop: Record<string, unknown>,
): ActionFieldMetadata | null {
	const propertyType = typeof prop.type === "string" ? prop.type : "";
	if (isAuthPropertyType(propertyType)) {
		return null;
	}

	const options = typeof prop.options === "function"
		? {
				kind: "dynamic" as const,
				refreshers: normalizeStringArray(prop.refreshers),
				refreshOnSearch: prop.refreshOnSearch === true,
			}
		: (() => {
				const staticOptions = normalizeStaticOptions(prop.options);
				return staticOptions.length > 0
					? {
							kind: "static" as const,
							values: staticOptions,
						}
					: null;
			})();

	const schemaType = PROP_TYPE_MAP[propertyType] || "string";
	return {
		name,
		displayName:
			typeof prop.displayName === "string" && prop.displayName.trim().length > 0
				? prop.displayName
				: humanizeLabel(name),
		description:
			typeof prop.description === "string" && prop.description.trim().length > 0
				? prop.description
				: null,
		propertyType: propertyType || "string",
		schemaType,
		required: prop.required === true,
		defaultValue: prop.defaultValue ?? null,
		dependsOn: normalizeStringArray(prop.refreshers),
		refreshers: normalizeStringArray(prop.refreshers),
		refreshOnSearch: prop.refreshOnSearch === true,
		options,
	};
}

function buildActionFields(
	props: Record<string, unknown> | undefined,
): ActionFieldMetadata[] {
	if (!props || typeof props !== "object") return [];

	return Object.entries(props)
		.map(([name, prop]) => {
			if (!prop || typeof prop !== "object" || Array.isArray(prop)) return null;
			return summarizeField(name, prop as Record<string, unknown>);
		})
		.filter((item): item is ActionFieldMetadata => item !== null);
}

/**
 * Convert AP action props to a JSON Schema object.
 */
function propsToJsonSchema(
	props: Record<string, { type?: string; displayName?: string; description?: string; required?: boolean; defaultValue?: unknown; options?: unknown }>,
): Record<string, unknown> {
	const properties: Record<string, Record<string, unknown>> = {};
	const required: string[] = [];

	for (const [propName, prop] of Object.entries(props)) {
		if (isAuthPropertyType(prop.type)) {
			continue;
		}
		const jsonType = PROP_TYPE_MAP[prop.type || ""] || "string";
		const property: Record<string, unknown> = {
			type: jsonType,
			...(prop.displayName ? { title: prop.displayName } : {}),
			...(prop.description ? { description: prop.description } : {}),
			...(prop.defaultValue !== undefined ? { default: prop.defaultValue } : {}),
		};
		if (prop.type === "STATIC_DROPDOWN") {
			const options = normalizeStaticOptions(prop.options);
			if (options.length > 0) {
				property.enum = options.map((option) => option.value);
			}
		}
		if (prop.type === "STATIC_MULTI_SELECT_DROPDOWN") {
			const options = normalizeStaticOptions(prop.options);
			property.items = {
				type: "string",
				...(options.length > 0 ? { enum: options.map((option) => option.value) } : {}),
			};
		}
		properties[propName] = property;
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

function schemaToParameters(schema: Record<string, unknown> | null): ActionMetadata["signature"]["parameters"] {
	if (!schema || schema.type !== "object") {
		return [];
	}
	const properties = schema.properties;
	if (!properties || typeof properties !== "object") {
		return [];
	}
	const required = new Set(
		Array.isArray(schema.required) ? schema.required.map((item) => String(item)) : []
	);
	return Object.entries(properties as Record<string, unknown>).map(([name, value]) => {
		const prop = value as Record<string, unknown>;
		return {
			name,
			type: typeof prop.type === "string" ? prop.type : "string",
			required: required.has(name),
			description: typeof prop.description === "string" ? prop.description : null,
		};
	});
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
			const requireAuth = action.requireAuth !== false && Boolean((piece as unknown as { auth?: unknown }).auth);
			const fnName = `${pieceName}-${actionName}`;
			catalog.push({
				name: fnName,
				version: "1.0.0",
				pieceName,
				providerLabel: ((piece as unknown as { displayName?: string }).displayName || pieceName),
				providerIconUrl:
					((piece as unknown as { logoUrl?: string }).logoUrl || null),
				category:
					Array.isArray((piece as unknown as { categories?: unknown[] }).categories) &&
					(piece as unknown as { categories?: unknown[] }).categories!.length > 0
						? String((piece as unknown as { categories: unknown[] }).categories[0] || '')
						: null,
				actionName,
				displayName: action.displayName || actionName,
				description: action.description || "",
				auth: summarizeAuth((piece as unknown as { auth?: unknown }).auth, requireAuth),
				fields: buildActionFields(action.props),
				definition: generateFunctionDefinition(pieceName, actionName, action),
			});
		}
	}

	return catalog;
}

export function toActionMetadata(
	catalogFunction: CatalogFunction,
	registered = true,
	sourceCode: string | null = null,
): ActionMetadata {
	const inputSchema = (catalogFunction.definition.input as { schema?: { document?: Record<string, unknown> } } | undefined)
		?.schema?.document ?? null;
	const call = `${catalogFunction.pieceName}/${catalogFunction.actionName}`;
	const taskConfig: Record<string, unknown> = {
		call,
		with: {
			body: {
				input: {},
				metadata: {
					pieceName: catalogFunction.pieceName,
					actionName: catalogFunction.actionName,
					sourceKind: "integration",
				},
			},
		},
		...(inputSchema
			? {
					input: {
						schema: {
							format: "json",
							document: inputSchema,
						},
					},
			  }
			: {}),
	};

	return {
		id: catalogFunction.name,
		name: catalogFunction.name,
		displayName: catalogFunction.displayName,
		description: catalogFunction.description,
		service: "fn-activepieces",
		runtime: "node-dapr-workflow",
		kind: "sw-function",
		visibility: "public-callable",
		sourceKind: "integration",
		providerId: catalogFunction.pieceName,
		providerLabel: catalogFunction.providerLabel,
		providerIconUrl: catalogFunction.providerIconUrl,
		category: catalogFunction.category,
		auth: catalogFunction.auth,
		fields: catalogFunction.fields,
		pieceName: catalogFunction.pieceName,
		actionName: catalogFunction.actionName,
		version: catalogFunction.version,
		registered,
		sourceCode,
		signature: {
			parameters: schemaToParameters(inputSchema),
			inputSchema,
		},
		swCompatibility: {
			status: "compatible",
			reasons: [],
			projection: {
				functionRefName: catalogFunction.name,
				call,
				inputShape: inputSchema ? "object" : "unknown",
			},
		},
		taskConfig,
		definition: catalogFunction.definition,
	};
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

/**
 * Prop Schema Converter
 *
 * Converts Activepieces prop definitions (from piece_metadata JSONB)
 * to JSON Schema for MCP tool inputSchema registration.
 */

type JsonSchemaProperty = {
	type?: string;
	description?: string;
	title?: string;
	enum?: unknown[];
	items?: JsonSchemaProperty;
	default?: unknown;
};

type JsonSchema = {
	type: "object";
	properties: Record<string, JsonSchemaProperty>;
	required?: string[];
};

type ApPropDef = {
	type?: string;
	displayName?: string;
	description?: string;
	required?: boolean;
	defaultValue?: unknown;
	options?: {
		options?: Array<{ label: string; value: unknown }>;
	} | Array<{ label: string; value: unknown }>;
};

/**
 * Convert a single AP prop definition to a JSON Schema property.
 * Returns null for prop types that should be skipped (auth, markdown, dynamic).
 */
export function apPropToJsonSchema(
	prop: ApPropDef,
): JsonSchemaProperty | null {
	const propType = prop.type;
	if (!propType) return null;

	const base: JsonSchemaProperty = {};
	if (prop.displayName) base.title = prop.displayName;
	if (prop.description) base.description = prop.description;
	if (prop.defaultValue !== undefined) base.default = prop.defaultValue;

	switch (propType) {
		case "SHORT_TEXT":
		case "LONG_TEXT":
		case "DATE_TIME":
		case "FILE":
			return { ...base, type: "string" };

		case "NUMBER":
			return { ...base, type: "number" };

		case "CHECKBOX":
			return { ...base, type: "boolean" };

		case "STATIC_DROPDOWN": {
			const schema: JsonSchemaProperty = { ...base, type: "string" };
			const options = extractStaticOptions(prop.options);
			if (options.length > 0) {
				schema.enum = options.map((o) => o.value);
				// Add option labels to description
				const optionLabels = options
					.map((o) => `${o.value}: ${o.label}`)
					.join(", ");
				schema.description = schema.description
					? `${schema.description} (Options: ${optionLabels})`
					: `Options: ${optionLabels}`;
			}
			return schema;
		}

		case "STATIC_MULTI_SELECT_DROPDOWN": {
			const schema: JsonSchemaProperty = {
				...base,
				type: "array",
				items: { type: "string" },
			};
			const options = extractStaticOptions(prop.options);
			if (options.length > 0) {
				schema.items = {
					type: "string",
					enum: options.map((o) => o.value),
				};
				const optionLabels = options
					.map((o) => `${o.value}: ${o.label}`)
					.join(", ");
				schema.description = schema.description
					? `${schema.description} (Options: ${optionLabels})`
					: `Options: ${optionLabels}`;
			}
			return schema;
		}

		case "DROPDOWN":
			return { ...base, type: "string" };

		case "MULTI_SELECT_DROPDOWN":
			return {
				...base,
				type: "array",
				items: { type: "string" },
			};

		case "JSON":
		case "OBJECT":
			return { ...base, type: "object" };

		case "ARRAY":
			return { ...base, type: "array" };

		// Skip auth-related, UI-only, and overly complex prop types
		case "OAUTH2":
		case "SECRET_TEXT":
		case "BASIC_AUTH":
		case "CUSTOM_AUTH":
		case "MARKDOWN":
		case "DYNAMIC":
			return null;

		default:
			// Unknown prop type — treat as string to be safe
			return { ...base, type: "string" };
	}
}

/**
 * Extract static dropdown options from the prop's options field.
 * Handles both nested { options: [...] } and flat [...] formats.
 */
function extractStaticOptions(
	options: ApPropDef["options"],
): Array<{ label: string; value: unknown }> {
	if (!options) return [];
	if (Array.isArray(options)) return options;
	if (Array.isArray(options.options)) return options.options;
	return [];
}

/**
 * Convert all props of an AP action to a JSON Schema object.
 * Skips auth and UI-only props. Returns a valid JSON Schema
 * suitable for MCP tool inputSchema.
 */
export function actionPropsToSchema(
	props: Record<string, ApPropDef>,
): JsonSchema {
	const properties: Record<string, JsonSchemaProperty> = {};
	const required: string[] = [];

	for (const [key, prop] of Object.entries(props)) {
		const schemaProp = apPropToJsonSchema(prop);
		if (!schemaProp) continue;

		properties[key] = schemaProp;

		if (prop.required) {
			required.push(key);
		}
	}

	return {
		type: "object" as const,
		properties,
		...(required.length > 0 ? { required } : {}),
	};
}

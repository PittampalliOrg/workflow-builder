import Ajv2020 from "ajv/dist/2020";

import type { RuntimeStructuredOutputCapability } from "./ports";

export type StructuredOutputSchemaValidation =
	| { ok: true; schema: Record<string, unknown> }
	| { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveLocalPointer(
	schema: Record<string, unknown>,
	ref: string,
): unknown {
	if (ref === "#") return schema;
	if (!ref.startsWith("#/")) return undefined;
	let current: unknown = schema;
	for (const rawPart of ref.slice(2).split("/")) {
		const part = rawPart.replaceAll("~1", "/").replaceAll("~0", "~");
		if (!isRecord(current) || !(part in current)) return undefined;
		current = current[part];
	}
	return current;
}

function isObjectShapedSchema(schema: Record<string, unknown>): boolean {
	let current: unknown = schema;
	const seen = new Set<string>();
	while (isRecord(current) && typeof current.$ref === "string") {
		if (seen.has(current.$ref)) return false;
		seen.add(current.$ref);
		current = resolveLocalPointer(schema, current.$ref);
	}
	if (!isRecord(current)) return false;
	return (
		current.type === "object" ||
		(current.type === undefined && isRecord(current.properties))
	);
}

export function validateDraft202012ObjectSchema(
	value: unknown,
): StructuredOutputSchemaValidation {
	if (!isRecord(value) || Object.keys(value).length === 0) {
		return {
			ok: false,
			error: "responseJsonSchema must be a non-empty object",
		};
	}

	const ajv = new Ajv2020({ strict: false, validateSchema: true });
	try {
		if (!ajv.validateSchema(value)) {
			return {
				ok: false,
				error: `responseJsonSchema is not valid Draft 2020-12: ${ajv.errorsText(
					ajv.errors,
				)}`,
			};
		}
		// Compilation resolves local references and rejects unresolved or remote
		// references before the runtime can be poisoned for its next turn.
		ajv.compile(value);
	} catch (error) {
		return {
			ok: false,
			error: `responseJsonSchema is not valid Draft 2020-12: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}

	if (!isObjectShapedSchema(value)) {
		return {
			ok: false,
			error: "StructuredOutput tool arguments require an object-shaped schema",
		};
	}
	return { ok: true, schema: structuredClone(value) };
}

export function runtimeSupportsStructuredOutput(
	capability: RuntimeStructuredOutputCapability | null | undefined,
): boolean {
	return (
		capability?.mode === "tool" && capability.jsonSchemaDraft === "2020-12"
	);
}

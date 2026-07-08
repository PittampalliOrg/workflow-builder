import { describe, expect, it } from "vitest";
import {
	encodeStructuredOutputSchema,
	parseStructuredOutputContext,
	shouldUseStructuredOutputTools,
	STRUCTURED_OUTPUT_MODE_HEADER,
	STRUCTURED_OUTPUT_SCHEMA_HEADER,
} from "./structured-output-tools.js";

describe("structured-output MCP headers", () => {
	it("detects structured-output mode and decodes the schema header", () => {
		const schema = {
			type: "object",
			properties: { answer: { type: "string" } },
			required: ["answer"],
			additionalProperties: false,
		};
		const headers = {
			[STRUCTURED_OUTPUT_MODE_HEADER]: "structured-output",
			[STRUCTURED_OUTPUT_SCHEMA_HEADER]: encodeStructuredOutputSchema(schema),
		};

		expect(shouldUseStructuredOutputTools(headers)).toBe(true);
		expect(parseStructuredOutputContext(headers)).toEqual({ schema });
	});

	it("normalizes property-only schemas to object schemas", () => {
		const schema = {
			properties: { ok: { type: "boolean" } },
			required: ["ok"],
		};
		const headers = {
			[STRUCTURED_OUTPUT_MODE_HEADER]: "structured-output",
			[STRUCTURED_OUTPUT_SCHEMA_HEADER]: encodeStructuredOutputSchema(schema),
		};

		expect(parseStructuredOutputContext(headers)).toEqual({
			schema: { ...schema, type: "object" },
		});
	});

	it("rejects structured-output mode without an object-shaped schema", () => {
		const headers = {
			[STRUCTURED_OUTPUT_MODE_HEADER.toLowerCase()]: "structured-output",
			[STRUCTURED_OUTPUT_SCHEMA_HEADER.toLowerCase()]:
				encodeStructuredOutputSchema({ type: "array", items: { type: "string" } }),
		};

		expect(() => parseStructuredOutputContext(headers)).toThrow(
			"structured-output schema must be an object-shaped JSON Schema",
		);
	});
});

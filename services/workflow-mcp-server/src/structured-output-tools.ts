/**
 * Structured-output MCP HTTP mode.
 *
 * This is the service-hosted equivalent of dapr-agent-py's synthetic
 * StructuredOutput tool. The production CLI path uses the local cli-agent-py
 * stdio MCP server; this HTTP mode remains useful for platform/debug callers
 * that stamp X-Wfb-Mcp-Mode=structured-output and a base64url-encoded JSON
 * Schema header. At MCP initialize time this server exposes exactly one tool:
 * StructuredOutput, whose inputSchema is that schema.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
	type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import Ajv2020, { type ErrorObject } from "ajv/dist/2020.js";
import { setSpanOutput } from "./observability/content.js";

export const STRUCTURED_OUTPUT_MODE_HEADER = "x-wfb-mcp-mode";
export const STRUCTURED_OUTPUT_SCHEMA_HEADER =
	"x-wfb-structured-output-schema-b64";
export const STRUCTURED_OUTPUT_MODE = "structured-output";
export const STRUCTURED_OUTPUT_TOOL_NAME = "StructuredOutput";

const SERVER_NAME = "workflow-builder-structured-output";
const SERVER_VERSION = "1.0.0";
const TOOL_DESCRIPTION =
	"Report your final structured result. Call this tool exactly once when you " +
	"have completed the task. The arguments are the final result object and must " +
	"satisfy the required output schema. If the tool reports validation errors, " +
	"correct the arguments and call it again.";

type Headers = Record<string, string | string[] | undefined>;
type JsonObject = Record<string, unknown>;

export type StructuredOutputContext = {
	schema: JsonObject;
};

function headerValue(headers: Headers, name: string): string {
	const value = headers[name.toLowerCase()] ?? headers[name];
	if (Array.isArray(value)) return value[0] ?? "";
	return typeof value === "string" ? value : "";
}

export function shouldUseStructuredOutputTools(headers: Headers): boolean {
	return (
		headerValue(headers, STRUCTURED_OUTPUT_MODE_HEADER).trim().toLowerCase() ===
		STRUCTURED_OUTPUT_MODE
	);
}

export function encodeStructuredOutputSchema(schema: JsonObject): string {
	return Buffer.from(JSON.stringify(schema), "utf8").toString("base64url");
}

export function parseStructuredOutputContext(
	headers: Headers,
): StructuredOutputContext | null {
	if (!shouldUseStructuredOutputTools(headers)) return null;
	const encoded = headerValue(headers, STRUCTURED_OUTPUT_SCHEMA_HEADER).trim();
	if (!encoded) {
		throw new Error(
			`missing ${STRUCTURED_OUTPUT_SCHEMA_HEADER} header for structured-output MCP mode`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch (err) {
		throw new Error(`invalid structured-output schema header: ${err}`);
	}
	const schema = normalizeObjectSchema(parsed);
	if (!schema) {
		throw new Error(
			"structured-output schema must be an object-shaped JSON Schema",
		);
	}
	return { schema };
}

function normalizeObjectSchema(value: unknown): JsonObject | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const schema = { ...(value as JsonObject) };
	const type = schema.type;
	if (type === "object") return schema;
	if (type === undefined && schema.properties && typeof schema.properties === "object") {
		return { ...schema, type: "object" };
	}
	return null;
}

function canonicalJson(value: JsonObject): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as JsonObject)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => [key, sortKeys(item)]),
	);
}

function validationErrorText(errors: ErrorObject[] | null | undefined): string {
	const lines = (errors ?? []).slice(0, 20).map((err) => {
		const path = err.instancePath
			? err.instancePath
					.slice(1)
					.split("/")
					.map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
					.join(".")
			: "<root>";
		return `${path || "<root>"}: ${err.message ?? "invalid value"}`;
	});
	return (
		"Error: StructuredOutput arguments failed schema validation:\n" +
		(lines.length ? lines.join("\n") : "<root>: invalid structured output") +
		"\nCorrect the arguments and call StructuredOutput again."
	);
}

function textResult(text: string, isError = false): CallToolResult {
	const result: CallToolResult = {
		content: [{ type: "text", text }],
	};
	if (isError) result.isError = true;
	setSpanOutput(isError ? { error: text } : text);
	return result;
}

export function createStructuredOutputMcpServer(schema: JsonObject): Server {
	const validator = new Ajv2020({
		allErrors: true,
		strict: false,
		allowUnionTypes: true,
	}).compile(schema);

	const server = new Server(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ capabilities: { tools: {} } },
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			{
				name: STRUCTURED_OUTPUT_TOOL_NAME,
				title: "Structured Output",
				description: TOOL_DESCRIPTION,
				inputSchema: schema as {
					type: "object";
					properties?: Record<string, object>;
					required?: string[];
				},
				annotations: {
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: false,
					openWorldHint: false,
				},
			},
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		if (request.params.name !== STRUCTURED_OUTPUT_TOOL_NAME) {
			return textResult(
				`Error: unknown tool ${request.params.name}; use ${STRUCTURED_OUTPUT_TOOL_NAME}.`,
				true,
			);
		}
		const args = request.params.arguments ?? {};
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			return textResult(
				"Error: StructuredOutput arguments must be a JSON object.",
				true,
			);
		}
		if (!validator(args)) {
			return textResult(validationErrorText(validator.errors), true);
		}
		const value = args as JsonObject;
		setSpanOutput(value);
		return {
			content: [{ type: "text", text: canonicalJson(value) }],
			structuredContent: value,
		};
	});

	return server;
}

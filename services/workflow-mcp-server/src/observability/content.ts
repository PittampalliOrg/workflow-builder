/**
 * Request/response content capture for workflow MCP server spans.
 *
 * Emits OpenInference `input.value` / `output.value` attributes on the active
 * span so the Service Graph drill-down drawer can show MCP requests, tool
 * arguments, and tool results. Values are deep-redacted before serialization.
 */

import { trace } from "@opentelemetry/api";

const MAX_BYTES = 60_000;
const MAX_DEPTH = 12;
const REDACTED = "[REDACTED]";

const SECRET_KEY_RE =
	/(token|secret|password|passwd|api[_-]?key|authorization|auth|credential|bearer|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|session[_-]?token|cookie|x-api-key)/i;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

const DIAGNOSTIC_TOOL_NAMES = new Set([
	"list_workflow_executions",
	"debug_workflow_execution",
	"trace_get_digest",
	"trace_search_spans",
	"trace_get_span",
	"trace_get_llm_turn",
	"trace_get_logs",
	"trace_get_browser_screenshot",
]);
const DIAGNOSTIC_ARGUMENT_NAMES = new Set([
	"executionId",
	"workflowId",
	"workflowName",
	"status",
	"spanId",
	"sessionId",
	"storageRef",
	"query",
	"errorsOnly",
	"limit",
	"cursor",
]);

function record(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function safeToken(value: unknown): string | undefined {
	return typeof value === "string" && /^[a-z0-9_.:/-]{1,100}$/i.test(value) ? value : undefined;
}

function arrayCount(root: Record<string, unknown>, key: string): number | undefined {
	return Array.isArray(root[key]) ? root[key].length : undefined;
}

function diagnosticDataSummary(value: unknown): Record<string, unknown> {
	const root = record(value);
	if (!root) return { present: value != null };
	const counts = Object.fromEntries(
		["executions", "spans", "turns", "logs", "browserArtifacts", "steps", "artifacts"]
			.map((key) => [key, arrayCount(root, key)] as const)
			.filter((entry): entry is readonly [string, number] => entry[1] !== undefined),
	);
	const page = record(root.page);
	const coverage = record(root.evidenceCoverage);
	const execution = record(root.execution) ?? record(record(root.overview)?.execution);
	const status = safeToken(execution?.status ?? root.status);
	const contentType =
		typeof root.contentType === "string" && root.contentType.startsWith("image/")
			? root.contentType.slice(0, 100)
			: undefined;
	const sizeBytes =
		typeof root.sizeBytes === "number" && Number.isFinite(root.sizeBytes)
			? root.sizeBytes
			: undefined;
	return {
		...(Object.keys(counts).length > 0 ? { counts } : {}),
		...(page
			? {
					page: {
						limit: typeof page.limit === "number" ? page.limit : undefined,
						count: typeof page.count === "number" ? page.count : undefined,
						truncated: page.truncated === true,
						hasNextCursor: typeof page.nextCursor === "string" && page.nextCursor.length > 0,
					},
				}
			: {}),
		...(coverage
			? {
					evidenceCoverage: Object.fromEntries(
						Object.entries(coverage)
							.map(([key, item]) => [key, safeToken(item)] as const)
							.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
					),
				}
			: {}),
		...(status ? { status } : {}),
		...(contentType ? { screenshot: { contentType, sizeBytes } } : {}),
	};
}

export type DiagnosticMcpRequestTrace = {
	kind: "workflow_diagnostic_mcp_request";
	tool: string;
	argumentNames: string[];
	pagination: {
		hasCursor: boolean;
		limit?: number;
	};
};

/** Return safe call metadata, or null when the JSON-RPC request is not diagnostic. */
export function diagnosticMcpRequestTrace(value: unknown): DiagnosticMcpRequestTrace | null {
	const root = record(value);
	const params = record(root?.params);
	const tool = safeToken(params?.name);
	if (root?.method !== "tools/call" || !tool || !DIAGNOSTIC_TOOL_NAMES.has(tool)) {
		return null;
	}
	const args = record(params?.arguments) ?? {};
	const limit =
		typeof args.limit === "number" && Number.isInteger(args.limit) ? args.limit : undefined;
	return {
		kind: "workflow_diagnostic_mcp_request",
		tool,
		argumentNames: Object.keys(args)
			.filter((name) => DIAGNOSTIC_ARGUMENT_NAMES.has(name))
			.sort(),
		pagination: {
			hasCursor: typeof args.cursor === "string" && args.cursor.length > 0,
			...(limit !== undefined ? { limit } : {}),
		},
	};
}

/** Summarize a diagnostic envelope without retaining evidence or identifiers. */
export function diagnosticEnvelopeTraceMetadata(
	value: unknown,
	tool?: string,
): Record<string, unknown> {
	const envelope = record(value) ?? {};
	const telemetry = record(envelope.telemetry) ?? {};
	const warnings = Array.isArray(telemetry.warnings) ? telemetry.warnings : [];
	const nextActions = Array.isArray(envelope.nextActions)
		? envelope.nextActions.map(record).filter((item) => item !== null)
		: [];
	const error = record(envelope.error);
	const safeTool = safeToken(tool);
	const refreshAfterMs =
		typeof telemetry.refreshAfterMs === "number" &&
		Number.isInteger(telemetry.refreshAfterMs) &&
		telemetry.refreshAfterMs > 0
			? telemetry.refreshAfterMs
			: undefined;
	return {
		kind: "workflow_diagnostic_mcp_response",
		...(safeTool ? { tool: safeTool } : {}),
		ok: envelope.ok === true,
		telemetry: {
			state: safeToken(telemetry.state) ?? "unknown",
			isFinal: telemetry.isFinal === true,
			warningCount: warnings.length,
			...(refreshAfterMs ? { refreshAfterMs } : {}),
		},
		data: diagnosticDataSummary(envelope.data),
		...(error
			? {
					error: {
						code: safeToken(error.code) ?? "diagnostics_failed",
						retryable: error.retryable === true,
					},
				}
			: {}),
		nextActionTools: nextActions
			.map((action) => safeToken(action.tool))
			.filter((item): item is string => item !== undefined),
	};
}

function diagnosticEnvelopeFromMcpResponse(value: unknown): unknown | null {
	const root = record(value);
	const result = record(root?.result);
	if (!result) return null;
	const structured = record(result.structuredContent);
	if (structured && typeof structured.ok === "boolean") return structured;
	const content = Array.isArray(result.content) ? result.content : [];
	for (const item of content) {
		const part = record(item);
		if (part?.type !== "text" || typeof part.text !== "string") continue;
		try {
			const parsed = JSON.parse(part.text);
			if (typeof record(parsed)?.ok === "boolean") return parsed;
		} catch {
			// Text content from non-envelope errors is deliberately not retained.
		}
	}
	return null;
}

/** Parse a complete JSON/SSE response into metadata-only trace output. */
export function diagnosticMcpResponseTrace(raw: string, tool: string): Record<string, unknown> {
	const candidates: unknown[] = [];
	try {
		candidates.push(JSON.parse(raw));
	} catch {
		for (const line of raw.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			try {
				candidates.push(JSON.parse(line.slice(5).trim()));
			} catch {
				// A truncated SSE event still produces safe generic metadata below.
			}
		}
	}
	for (const candidate of candidates) {
		const envelope = diagnosticEnvelopeFromMcpResponse(candidate);
		if (envelope) return diagnosticEnvelopeTraceMetadata(envelope, tool);
	}
	return {
		kind: "workflow_diagnostic_mcp_response",
		tool,
		parsedEnvelope: false,
	};
}

function contentTracingEnabled(): boolean {
	const beta = (process.env.ENABLE_BETA_TRACING_DETAILED ?? "")
		.trim()
		.toLowerCase();
	if (TRUTHY.has(beta)) return true;
	const req = (process.env.ENABLE_REQUEST_CONTENT_TRACING ?? "")
		.trim()
		.toLowerCase();
	return !FALSY.has(req);
}

function redactDeep(value: unknown, depth = 0): unknown {
	if (depth > MAX_DEPTH) return "[redaction-depth-exceeded]";
	if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = SECRET_KEY_RE.test(k) ? REDACTED : redactDeep(v, depth + 1);
		}
		return out;
	}
	return value;
}

function serialize(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function setSpanIo(prefix: "input" | "output", value: unknown): void {
	if (value == null || !contentTracingEnabled()) return;
	const span = trace.getActiveSpan();
	if (!span) return;
	try {
		const serialized = serialize(redactDeep(value));
		if (!serialized) return;
		const bytes = Buffer.byteLength(serialized, "utf-8");
		const truncated = bytes > MAX_BYTES;
		const out = truncated
			? Buffer.from(serialized, "utf-8").subarray(0, MAX_BYTES).toString("utf-8")
			: serialized;
		span.setAttribute(`${prefix}.value`, out);
		span.setAttribute(`${prefix}.mime_type`, "application/json");
		if (truncated) {
			span.setAttribute(`${prefix}.value_truncated`, true);
			span.setAttribute(`${prefix}.value_original_length`, bytes);
		}
	} catch {
		// Observability must never break request handling.
	}
}

export function setSpanInput(value: unknown): void {
	setSpanIo("input", value);
}

export function setSpanOutput(value: unknown): void {
	setSpanIo("output", value);
}

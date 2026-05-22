/**
 * Request/response content capture for fn-system spans.
 *
 * Emits OpenInference `input.value` / `output.value` attributes on the active
 * span — the convention dapr-agent-py's tracing uses and the Service Graph
 * drill-down drawer renders — so system steps (http-request, database-query,
 * condition, …) carry their actual request/response payloads.
 *
 * fn-system receives decrypted `credentials` and may carry Authorization
 * headers in step input, so EVERY value is deep-redacted before serialization:
 * any object key matching a secret-ish pattern → "[REDACTED]".
 *
 * Gating (matches the rest of the system): **on by default** for this backend
 * hop — bounded JSON, 60 KB cap, secret-redacted, ClickHouse-only. Set
 * ENABLE_REQUEST_CONTENT_TRACING=false to opt out; ENABLE_BETA_TRACING_DETAILED
 * truthy forces it on.
 */

import { trace } from "@opentelemetry/api";

const MAX_BYTES = 60_000;
const MAX_DEPTH = 12;
const REDACTED = "[REDACTED]";

const SECRET_KEY_RE =
	/(token|secret|password|passwd|api[_-]?key|authorization|auth|credential|bearer|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|session[_-]?token|cookie|x-api-key)/i;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export function contentTracingEnabled(): boolean {
	const beta = (process.env.ENABLE_BETA_TRACING_DETAILED ?? "").trim().toLowerCase();
	if (TRUTHY.has(beta)) return true;
	const req = (process.env.ENABLE_REQUEST_CONTENT_TRACING ?? "").trim().toLowerCase();
	return !FALSY.has(req);
}

export function redactDeep(value: unknown, depth = 0): unknown {
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

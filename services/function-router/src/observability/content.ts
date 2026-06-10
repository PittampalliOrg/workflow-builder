/**
 * Request/response content capture for function-router spans.
 *
 * Emits OpenInference `input.value` / `output.value` attributes on the active
 * span — the same convention dapr-agent-py's state/LLM tracing uses and the
 * Service Graph drill-down drawer (`drilldown-io.svelte` / `parseIoValue`)
 * renders. This lets the function-router hop carry the actual payload it
 * routed to a backend (fn-system / ap-<piece>-service / openshell /
 * code-runtime), not just HTTP status + duration.
 *
 * function-router is the credential broker (it decrypts app_connection
 * secrets), so EVERY value is deep-redacted before serialization: any object
 * key matching a secret-ish pattern has its value replaced with "[REDACTED]".
 *
 * Gating (matches the Python side): **on by default** for this backend hop —
 * payloads are bounded JSON (60 KB cap, secret-redacted) and span attributes
 * only flow to ClickHouse, never back into an LLM context. Set
 * ENABLE_REQUEST_CONTENT_TRACING=false to opt out; ENABLE_BETA_TRACING_DETAILED
 * truthy forces it on.
 */

import { trace, type Span } from "@opentelemetry/api";

// Match dapr-agent-py state_tracing: 60 KB per value.
const MAX_BYTES = 60_000;
const MAX_DEPTH = 12;
const REDACTED = "[REDACTED]";

const SECRET_KEY_RE =
  /(token|secret|password|passwd|api[_-]?key|authorization|auth|credential|bearer|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|session[_-]?token|cookie|x-api-key)/i;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export function contentTracingEnabled(): boolean {
  const beta = (process.env.ENABLE_BETA_TRACING_DETAILED ?? "")
    .trim()
    .toLowerCase();
  if (TRUTHY.has(beta)) return true;
  const req = (process.env.ENABLE_REQUEST_CONTENT_TRACING ?? "")
    .trim()
    .toLowerCase();
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

/** Stamp `<prefix>.value` (+ mime/truncation) on `span` for `value`. */
function setSpanIoOnSpan(
  span: Span | undefined,
  prefix: "input" | "output",
  value: unknown,
): void {
  if (value == null || !contentTracingEnabled()) return;
  if (!span) return;
  try {
    const serialized = serialize(redactDeep(value));
    if (!serialized) return;
    const bytes = Buffer.byteLength(serialized, "utf-8");
    const truncated = bytes > MAX_BYTES;
    const out = truncated
      ? Buffer.from(serialized, "utf-8")
          .subarray(0, MAX_BYTES)
          .toString("utf-8")
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

/** Stamp `<prefix>.value` (+ mime/truncation) on the active span for `value`. */
function setSpanIo(prefix: "input" | "output", value: unknown): void {
  setSpanIoOnSpan(trace.getActiveSpan(), prefix, value);
}

export function setSpanInput(value: unknown): void {
  setSpanIo("input", value);
}

export function setSpanInputOnSpan(
  span: Span | undefined,
  value: unknown,
): void {
  setSpanIoOnSpan(span, "input", value);
}

/**
 * Stamp `output.value` from a response payload. Accepts the serialized string
 * Fastify hands to `onSend` (parsed best-effort so redaction still applies) or
 * a plain object.
 */
export function setSpanOutput(payload: unknown): void {
  if (!contentTracingEnabled()) return;
  let value: unknown = payload;
  if (typeof payload === "string") {
    try {
      value = JSON.parse(payload);
    } catch {
      value = payload;
    }
  }
  setSpanIo("output", value);
}

export function setSpanOutputOnSpan(
  span: Span | undefined,
  payload: unknown,
): void {
  if (!contentTracingEnabled()) return;
  let value: unknown = payload;
  if (typeof payload === "string") {
    try {
      value = JSON.parse(payload);
    } catch {
      value = payload;
    }
  }
  setSpanIoOnSpan(span, "output", value);
}

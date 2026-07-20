import { trace, type Span } from '@opentelemetry/api';

const DEFAULT_MAX_BYTES = 60_000;
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off']);
const REDACTED = '[REDACTED]';
const MAX_REDACT_DEPTH = 12;
const IMAGE_DATA_URI_PATTERN = /data:image\/[^,\s]+;base64,[a-z0-9+\/_=-]+/gi;
const SERIALIZED_PAYLOAD_BASE64_PATTERN =
	/(\\?"payload[_-]?base64\\?"\s*:\s*\\?")[a-z0-9+\/_=-]*(\\?")?/gi;
const SECRET_KEY_PATTERN =
	/(token|secret|password|passwd|api[_-]?key|authorization|auth|credential|bearer|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|session[_-]?token|cookie|x-api-key|payload[_-]?base64)/i;

function redactString(value: string): string {
	return value
		.replace(IMAGE_DATA_URI_PATTERN, '[REDACTED image data URI]')
		.replace(
			SERIALIZED_PAYLOAD_BASE64_PATTERN,
			(_match, prefix: string, closingQuote: string | undefined) =>
				`${prefix}${REDACTED}${closingQuote ?? ''}`
		);
}

export function contentTracingEnabled(): boolean {
	if (TRUTHY.has((process.env.ENABLE_BETA_TRACING_DETAILED ?? '').trim().toLowerCase())) {
		return true;
	}
	return !FALSY.has((process.env.ENABLE_REQUEST_CONTENT_TRACING ?? '').trim().toLowerCase());
}

function redact(value: unknown, depth = 0): unknown {
	if (depth > MAX_REDACT_DEPTH) return '[redaction-depth-exceeded]';
	if (typeof value === 'string') return redactString(value);
	if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
	if (value && typeof value === 'object') {
		if (value instanceof URLSearchParams) return redact(Object.fromEntries(value), depth + 1);
		if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`;
		if (ArrayBuffer.isView(value)) return `[${value.constructor.name} ${value.byteLength} bytes]`;
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(child, depth + 1);
		}
		return out;
	}
	return value;
}

/**
 * Recursively redact secret-looking values from an arbitrary object/array,
 * masking any key matching {@link SECRET_KEY_PATTERN} (token / secret /
 * authorization / bearer / api-key / cookie / …). Safe-by-design for surfacing
 * resolved config in a UI (e.g. the compiled-capabilities debug panel).
 *
 * NOTE: `x-connection-external-id` is intentionally NOT matched — it is an
 * audit-only opaque reference (the piece-runtime self-resolves the plaintext
 * credential via the BFF `/decrypt` at point of use), so it stays visible.
 */
export function redactSecrets<T>(value: T): T {
	return redact(value) as T;
}

function serialize(value: unknown): string {
	if (typeof value === 'string') return value;
	try {
		return JSON.stringify(value, (_key, child) => {
			if (typeof child === 'bigint') return child.toString();
			return child;
		});
	} catch {
		return String(value);
	}
}

export function setSpanValue(
	span: Span | undefined,
	prefix: 'input' | 'output',
	value: unknown,
	maxBytes = DEFAULT_MAX_BYTES
): void {
	if (!span || value == null || !contentTracingEnabled()) return;
	try {
		const serialized = serialize(redact(value));
		if (!serialized) return;
		const encoded = Buffer.from(serialized, 'utf8');
		const truncated = encoded.byteLength > maxBytes;
		const selected = truncated ? encoded.subarray(0, maxBytes).toString('utf8') : serialized;
		span.setAttribute(`${prefix}.value`, selected);
		span.setAttribute(`${prefix}.mime_type`, 'application/json');
		if (truncated) {
			span.setAttribute(`${prefix}.value_truncated`, true);
			span.setAttribute(`${prefix}.value_original_length`, encoded.byteLength);
		}
	} catch {
		// Observability must never break the request path.
	}
}

export function setCurrentSpanInput(value: unknown): void {
	setSpanValue(trace.getActiveSpan(), 'input', value);
}

export function setCurrentSpanOutput(value: unknown): void {
	setSpanValue(trace.getActiveSpan(), 'output', value);
}

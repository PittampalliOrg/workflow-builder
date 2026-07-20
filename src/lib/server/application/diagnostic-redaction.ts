const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const AUTHORIZATION_HEADER_PATTERN =
	/\b(authorization|proxy-authorization)\s*:\s*(?:basic|digest|bearer)\s+[^\s,;]+/gi;
const COOKIE_HEADER_PATTERN = /\b(cookie|set-cookie)\s*:\s*[^\r\n]+/gi;
const URL_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi;
const ASSIGNMENT_PATTERN =
	/\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|session[_ -]?token|password|passwd|secret)\s*[:=]\s*["']?[^\s,"'}]+["']?/gi;
const IMAGE_DATA_URI_PATTERN = /data:image\/[^,\s]+;base64,[a-z0-9+\/_=-]+/gi;
const SERIALIZED_PAYLOAD_BASE64_PATTERN =
	/(\\?"payload[_-]?base64\\?"\s*:\s*\\?")[a-z0-9+\/_=-]*(\\?")?/gi;
const SECRET_KEY_PATTERN =
	/(token|secret|password|passwd|api[_-]?key|authorization|auth|credential|bearer|private[_-]?key|client[_-]?secret|refresh[_-]?token|access[_-]?token|session[_-]?token|cookie|x-api-key|payload[_-]?base64)/i;

function redactText(value: string): string {
	return value
		.replace(URL_USERINFO_PATTERN, '$1[REDACTED]@')
		.replace(AUTHORIZATION_HEADER_PATTERN, '$1: [REDACTED]')
		.replace(COOKIE_HEADER_PATTERN, '$1: [REDACTED]')
		.replace(BEARER_PATTERN, 'Bearer [REDACTED]')
		.replace(ASSIGNMENT_PATTERN, (_match, label: string) => `${label}=[REDACTED]`)
		.replace(IMAGE_DATA_URI_PATTERN, '[REDACTED image data URI]')
		.replace(
			SERIALIZED_PAYLOAD_BASE64_PATTERN,
			(_match, prefix: string, closingQuote: string | undefined) =>
				`${prefix}[REDACTED]${closingQuote ?? ''}`
		);
}

function redactStrings(value: unknown, depth = 0): unknown {
	if (depth > 12) return '[redaction-depth-exceeded]';
	if (typeof value === 'string') return redactText(value);
	if (Array.isArray(value)) return value.map((item) => redactStrings(item, depth + 1));
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, child]) => [
				key,
				SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactStrings(child, depth + 1)
			])
		);
	}
	return value;
}

/** Defense-in-depth redaction for trace content returned to MCP consumers. */
export function redactDiagnosticEvidence<T>(value: T): T {
	return redactStrings(value) as T;
}

/** Redact and cap arbitrary trace evidence while retaining its JSON shape. */
export function boundDiagnosticEvidence(
	value: unknown,
	maxCharacters: number
): { value: unknown; truncated: boolean } {
	const limit = Math.max(2, Math.floor(maxCharacters));
	let remaining = limit;
	let truncated = false;
	const size = (input: unknown) => Buffer.byteLength(JSON.stringify(input), 'utf8');
	const consumePrimitive = (input: unknown): unknown => {
		const bytes = size(input);
		if (bytes <= remaining) {
			remaining -= bytes;
			return input;
		}
		truncated = true;
		if (typeof input !== 'string') {
			const fallback = null;
			remaining = Math.max(0, remaining - size(fallback));
			return fallback;
		}
		const marker = '[content-truncated]';
		let low = 0;
		let high = input.length;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (size(`${input.slice(0, middle)}${marker}`) <= remaining) low = middle;
			else high = middle - 1;
		}
		const selected = `${input.slice(0, low)}${marker}`;
		if (size(selected) > remaining) {
			remaining = Math.max(0, remaining - size(''));
			return '';
		}
		remaining -= size(selected);
		return selected;
	};
	const visit = (input: unknown, depth = 0): unknown => {
		if (depth > 12) {
			truncated = true;
			return consumePrimitive('[depth-truncated]');
		}
		if (input == null || typeof input !== 'object') return consumePrimitive(input);
		if (Array.isArray(input)) {
			remaining = Math.max(0, remaining - 2);
			const output: unknown[] = [];
			for (const item of input) {
				const separator = output.length > 0 ? 1 : 0;
				if (remaining <= separator + 4) {
					truncated = true;
					break;
				}
				remaining -= separator;
				output.push(visit(item, depth + 1));
			}
			return output;
		}
		remaining = Math.max(0, remaining - 2);
		const output: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
			const keyCost = size(key) + 1 + (Object.keys(output).length > 0 ? 1 : 0);
			if (remaining <= keyCost + 4) {
				truncated = true;
				break;
			}
			remaining -= keyCost;
			output[key] = visit(child, depth + 1);
		}
		return output;
	};
	let bounded = visit(redactDiagnosticEvidence(value));
	if (size(bounded) > limit) {
		truncated = true;
		bounded = consumePrimitive(JSON.stringify(bounded));
	}
	return { value: bounded, truncated };
}

/**
 * Parse + present OpenInference `input.value` / `output.value` span attributes and
 * pull gen_ai / llm token + model info from a span's attributes. The drill-down
 * drawer renders LLM/tool content from these (the obs.llm_spans / obs.tool_spans
 * message columns are empty unless ENABLE_BETA_TRACING_DETAILED is set).
 */

export const CONTENT_CAP = 8000;

export interface IoMessage {
	role: string;
	content: string;
}
export interface ParsedIo {
	messages?: IoMessage[];
	text?: string;
	json?: unknown;
}

/** Flatten Anthropic/OpenAI-style content (string | block[]) into display text. */
function contentToText(content: unknown): string {
	if (content == null) return '';
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		const parts = content.map((b) => {
			if (typeof b === 'string') return b;
			if (b && typeof b === 'object') {
				const o = b as Record<string, unknown>;
				if (typeof o.text === 'string') return o.text;
				if (o.type === 'tool_use' || o.type === 'tool_result')
					return '```json\n' + safeStringify(o) + '\n```';
			}
			return '';
		});
		const joined = parts.filter(Boolean).join('\n\n');
		if (joined) return joined;
	}
	return safeStringify(content);
}

function safeStringify(v: unknown): string {
	try {
		return JSON.stringify(v, null, 2);
	} catch {
		return String(v);
	}
}

function toMessages(arr: unknown[]): IoMessage[] {
	return arr
		.filter((m) => m && typeof m === 'object' && ('role' in m || 'content' in m))
		.map((m) => {
			const o = m as Record<string, unknown>;
			return { role: String(o.role ?? 'message'), content: contentToText(o.content) };
		})
		.filter((m) => m.content);
}

/** Normalize an input.value/output.value attribute into something renderable. */
export function parseIoValue(raw: unknown): ParsedIo {
	if (raw == null) return {};
	let v: unknown = raw;
	if (typeof raw === 'string') {
		const t = raw.trim();
		if (!t) return {};
		if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
			try {
				v = JSON.parse(t);
			} catch {
				return { text: raw };
			}
		} else {
			return { text: raw };
		}
	}

	if (Array.isArray(v)) {
		const msgs = toMessages(v);
		return msgs.length ? { messages: msgs } : { json: v };
	}
	if (v && typeof v === 'object') {
		const o = v as Record<string, unknown>;
		if (Array.isArray(o.messages)) {
			const msgs = toMessages(o.messages);
			if (msgs.length) return { messages: msgs };
		}
		for (const k of ['content', 'task', 'text', 'prompt', 'response', 'output', 'result']) {
			if (typeof o[k] === 'string' && (o[k] as string).trim()) return { text: o[k] as string };
		}
		return { json: v };
	}
	return { text: String(v) };
}

/** Cap a long string for display, appending a truncation note. */
export function capText(s: string, cap = CONTENT_CAP): string {
	return s.length > cap ? `${s.slice(0, cap)}\n\n…(${s.length - cap} more chars truncated)` : s;
}

type Attrs = Record<string, unknown> | null | undefined;

export function attrNumber(attrs: Attrs, keys: string[]): number | null {
	const a = attrs ?? {};
	for (const k of keys) {
		if (k in a) {
			const n = typeof a[k] === 'number' ? (a[k] as number) : Number(a[k]);
			if (Number.isFinite(n)) return n;
		}
	}
	return null;
}

function attrString(attrs: Attrs, keys: string[]): string | null {
	const a = attrs ?? {};
	for (const k of keys) {
		const v = a[k];
		if (typeof v === 'string' && v.trim()) return v;
	}
	return null;
}

export function llmTokens(attrs: Attrs): {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	total: number | null;
} {
	return {
		input: attrNumber(attrs, ['gen_ai.usage.input_tokens', 'llm.token_count.prompt', 'usage.prompt_tokens', 'prompt_tokens']),
		output: attrNumber(attrs, ['gen_ai.usage.output_tokens', 'llm.token_count.completion', 'usage.completion_tokens', 'completion_tokens']),
		cacheRead: attrNumber(attrs, ['gen_ai.usage.cache_read_input_tokens', 'llm.token_count.cache_read']),
		total: attrNumber(attrs, ['gen_ai.usage.total_tokens', 'llm.token_count.total'])
	};
}

export function llmModel(attrs: Attrs): string | null {
	return attrString(attrs, ['gen_ai.request.model', 'gen_ai.response.model', 'llm.model_name', 'gen_ai.system']);
}
export function llmFinish(attrs: Attrs): string | null {
	return attrString(attrs, ['gen_ai.response.finish_reasons', 'llm.finish_reason', 'finish_reason']);
}
export function toolName(attrs: Attrs): string | null {
	return attrString(attrs, ['gen_ai.tool.name', 'tool.name']);
}

import { env } from '$env/dynamic/private';
import { createOpenAI, openai } from '@ai-sdk/openai';

type ChatMessage = {
	role: 'system' | 'user' | 'assistant';
	content: string;
};

function normalizeBaseUrl(value: string | undefined | null): string | null {
	const trimmed = (value ?? '').trim().replace(/\/+$/, '');
	return trimmed || null;
}

function normalizeModel(model: string | undefined | null, fallback = 'gpt-5.5'): string {
	const raw = (model ?? '').trim() || fallback;
	return raw.startsWith('openai/') ? raw.slice('openai/'.length) : raw;
}

// Reasoning models (e.g. DeepSeek V4, o-series) spend completion tokens on an
// internal reasoning pass BEFORE emitting content — at a low cap they return
// finish_reason=length with EMPTY content. Floor the output budget so callers
// that pass a small max_tokens (e.g. greenfield's 800) don't get empty results
// when the default model is a reasoning model.
const REASONING_MIN_OUTPUT_TOKENS = Number(env.REASONING_MIN_OUTPUT_TOKENS) || 8000;

function isReasoningModel(model: string): boolean {
	const lower = model.toLowerCase();
	return /deepseek.*v4|deepseek-reasoner|^o\d/.test(lower);
}

function effectiveMaxTokens(model: string, maxTokens: number): number {
	return isReasoningModel(model)
		? Math.max(maxTokens, REASONING_MIN_OUTPUT_TOKENS)
		: maxTokens;
}

function completionTokenLimit(model: string, maxTokens: number) {
	const lower = model.toLowerCase();
	const cap = effectiveMaxTokens(model, maxTokens);
	if (lower.startsWith('gpt-5') || /^o\d/.test(lower)) {
		return { max_completion_tokens: cap };
	}
	return { max_tokens: cap };
}

export function openAICompatibleGatewayBaseUrl(): string | null {
	return normalizeBaseUrl(env.LLM_GATEWAY_OPENAI_BASE_URL ?? env.OPENAI_COMPATIBLE_GATEWAY_BASE_URL);
}

export function openAICompatibleTrafficAvailable(): boolean {
	return Boolean(env.OPENAI_API_KEY || openAICompatibleGatewayBaseUrl());
}

export function workflowOpenAIModel(model: string | undefined | null) {
	const normalizedModel = normalizeModel(model);
	const gatewayBaseUrl = openAICompatibleGatewayBaseUrl();
	if (!gatewayBaseUrl) return openai(normalizedModel);
	return createOpenAI({
		baseURL: gatewayBaseUrl,
		apiKey: env.LLM_GATEWAY_API_KEY || env.AI_GATEWAY_API_KEY || env.OPENAI_API_KEY || 'unused',
		name: 'llm-gateway'
	})(normalizedModel);
}

export async function callOpenAICompatibleChatCompletion(params: {
	model?: string | null;
	maxTokens: number;
	responseFormat?: { type: 'json_object' };
	messages: ChatMessage[];
}): Promise<string> {
	const gatewayBaseUrl = openAICompatibleGatewayBaseUrl();
	const baseUrl = gatewayBaseUrl ?? 'https://api.openai.com/v1';
	const apiKey = gatewayBaseUrl
		? env.LLM_GATEWAY_API_KEY || env.AI_GATEWAY_API_KEY || env.OPENAI_API_KEY || 'unused'
		: env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
	const model = normalizeModel(params.model);
	const body = JSON.stringify({
		model,
		...completionTokenLimit(model, params.maxTokens),
		...(params.responseFormat ? { response_format: params.responseFormat } : {}),
		messages: params.messages
	});

	// DeepSeek's JSON-mode docs warn the API "may occasionally return empty
	// content" (https://api-docs.deepseek.com/guides/json_mode). DeepSeek V4 (and
	// other reasoning models) also intermittently return blank content. Retry the
	// request a few times on empty content before failing — a single empty
	// response should not hard-fail planGoal/greenfield/ai-assistant. (4xx is a
	// real client error and is not retried.)
	const maxAttempts = Math.max(1, Number(env.LLM_EMPTY_CONTENT_RETRIES) || 3);
	let lastErr = '';
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
			body
		});
		if (!response.ok) {
			const detail = await response.text();
			// Retry transient 5xx; fail fast on 4xx.
			if (response.status >= 500 && attempt < maxAttempts) {
				lastErr = `HTTP ${response.status}: ${detail}`;
				await new Promise((r) => setTimeout(r, 500 * attempt));
				continue;
			}
			throw new Error(`OpenAI-compatible API error ${response.status}: ${detail}`);
		}
		const data = await response.json();
		const content = data.choices?.[0]?.message?.content;
		if (content) return content;
		lastErr = 'empty content';
		if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 500 * attempt));
	}
	throw new Error(
		`No content in OpenAI-compatible response after ${maxAttempts} attempts (${lastErr})`
	);
}

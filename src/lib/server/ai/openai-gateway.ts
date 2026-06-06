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

function completionTokenLimit(model: string, maxTokens: number) {
	const lower = model.toLowerCase();
	if (lower.startsWith('gpt-5') || /^o\d/.test(lower)) {
		return { max_completion_tokens: maxTokens };
	}
	return { max_tokens: maxTokens };
}

export function openAICompatibleGatewayBaseUrl(): string | null {
	return normalizeBaseUrl(env.MLFLOW_AI_GATEWAY_OPENAI_BASE_URL);
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
		apiKey: env.MLFLOW_AI_GATEWAY_API_KEY || env.AI_GATEWAY_API_KEY || env.OPENAI_API_KEY || 'unused',
		name: 'mlflow-ai-gateway'
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
		? env.MLFLOW_AI_GATEWAY_API_KEY || env.AI_GATEWAY_API_KEY || env.OPENAI_API_KEY || 'unused'
		: env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
	const model = normalizeModel(params.model);

	const response = await fetch(`${baseUrl}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`
		},
		body: JSON.stringify({
			model,
			...completionTokenLimit(model, params.maxTokens),
			...(params.responseFormat ? { response_format: params.responseFormat } : {}),
			messages: params.messages
		})
	});

	if (!response.ok) {
		throw new Error(`OpenAI-compatible API error ${response.status}: ${await response.text()}`);
	}

	const data = await response.json();
	const content = data.choices?.[0]?.message?.content;
	if (!content) throw new Error('No content in OpenAI-compatible response');
	return content;
}

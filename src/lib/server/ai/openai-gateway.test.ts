import { describe, expect, it } from 'vitest';
import {
	buildOpenAICompatibleChatRequest,
	enforceKimiK3ChatRequestBody,
	isKimiK3Model
} from './openai-gateway';

describe('OpenAI-compatible Kimi K3 request policy', () => {
	it('recognizes bare and provider-qualified Kimi K3 model ids', () => {
		expect(isKimiK3Model('kimi-k3')).toBe(true);
		expect(isKimiK3Model('kimi/kimi-k3')).toBe(true);
		expect(isKimiK3Model('moonshot/kimi-k3')).toBe(true);
		expect(isKimiK3Model('kimi-k2.6')).toBe(false);
	});

	it('forces max reasoning and the K3 completion-token field', () => {
		const request = buildOpenAICompatibleChatRequest({
			model: 'kimi-k3',
			maxTokens: 800,
			messages: [{ role: 'user', content: 'Plan this workflow.' }]
		});

		expect(request).toMatchObject({
			model: 'kimi-k3',
			reasoning_effort: 'max',
			max_completion_tokens: 131072
		});
		expect(request).not.toHaveProperty('max_tokens');
	});

	it('enforces the same policy on AI SDK chat requests', () => {
		const encoded = enforceKimiK3ChatRequestBody(JSON.stringify({
			model: 'kimi-k3',
			max_tokens: 8192,
			messages: []
		}));
		const request = JSON.parse(encoded) as Record<string, unknown>;

		expect(request.reasoning_effort).toBe('max');
		expect(request.max_completion_tokens).toBe(131072);
		expect(request).not.toHaveProperty('max_tokens');
	});
});

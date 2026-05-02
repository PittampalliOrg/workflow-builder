import { describe, expect, it } from 'vitest';
import {
	AGENT_MODEL_OPTIONS,
	agentModelLabel,
	canonicalAgentModelSpec,
	isSupportedAgentModelSpec
} from './model-options';

describe('agent model options', () => {
	it('advertises only Dapr components supported by dapr-agent-py today', () => {
		expect(AGENT_MODEL_OPTIONS.map((option) => option.value)).toEqual([
			'anthropic/claude-opus-4-7',
			'anthropic/claude-sonnet-4-6',
			'anthropic/claude-haiku-4-5-20251001',
			'openai/gpt-5.4',
			'openai/o3',
			'googleai/gemini-3.1-pro-preview',
			'deepseek/default',
			'huggingface/meta-llama/Meta-Llama-3-8B',
			'mistral/open-mistral-7b',
			'echo/local'
		]);
	});

	it('canonicalizes legacy and short aliases to the dropdown values', () => {
		expect(canonicalAgentModelSpec('claude-opus-4-7')).toBe(
			'anthropic/claude-opus-4-7'
		);
		expect(canonicalAgentModelSpec('claude-opus-4-6')).toBe(
			'anthropic/claude-opus-4-7'
		);
		expect(canonicalAgentModelSpec('claude-haiku-4-5')).toBe(
			'anthropic/claude-haiku-4-5-20251001'
		);
		expect(canonicalAgentModelSpec('gpt-5.4')).toBe('openai/gpt-5.4');
		expect(canonicalAgentModelSpec('o3')).toBe('openai/o3');
		expect(canonicalAgentModelSpec('google/gemini-3.1-pro-preview')).toBe(
			'googleai/gemini-3.1-pro-preview'
		);
		expect(canonicalAgentModelSpec('meta-llama/Meta-Llama-3-8B')).toBe(
			'huggingface/meta-llama/Meta-Llama-3-8B'
		);
		expect(canonicalAgentModelSpec('open-mistral-7b')).toBe(
			'mistral/open-mistral-7b'
		);
	});

	it('does not bless models without a mapped Dapr runtime component', () => {
		expect(isSupportedAgentModelSpec('gpt-5-mini')).toBe(false);
		expect(isSupportedAgentModelSpec('openai/gpt-5.3-codex')).toBe(false);
		expect(isSupportedAgentModelSpec('ollama/llama3.2')).toBe(false);
	});

	it('formats known aliases with their canonical label', () => {
		expect(agentModelLabel('claude-opus-4-6')).toBe('Claude Opus 4.7');
		expect(agentModelLabel('openai/o3')).toBe('o3');
		expect(agentModelLabel('google/gemini-3.1-pro-preview')).toBe(
			'Gemini 3.1 Pro Preview'
		);
	});
});

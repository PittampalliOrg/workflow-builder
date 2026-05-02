export type AgentModelProvider =
	| 'anthropic'
	| 'openai'
	| 'googleai'
	| 'deepseek'
	| 'huggingface'
	| 'mistral'
	| 'echo';

export type AgentModelOption = {
	value: string;
	label: string;
	provider: AgentModelProvider;
	component: string;
};

export const AGENT_MODEL_OPTIONS: AgentModelOption[] = [
	{
		value: 'anthropic/claude-opus-4-7',
		label: 'Claude Opus 4.7',
		provider: 'anthropic',
		component: 'llm-anthropic-opus'
	},
	{
		value: 'anthropic/claude-sonnet-4-6',
		label: 'Claude Sonnet 4.6',
		provider: 'anthropic',
		component: 'llm-anthropic-sonnet'
	},
	{
		value: 'anthropic/claude-haiku-4-5-20251001',
		label: 'Claude Haiku 4.5',
		provider: 'anthropic',
		component: 'llm-anthropic-haiku'
	},
	{
		value: 'openai/gpt-5.4',
		label: 'GPT-5.4',
		provider: 'openai',
		component: 'llm-openai-gpt5'
	},
	{
		value: 'openai/o3',
		label: 'o3',
		provider: 'openai',
		component: 'llm-openai-o3'
	},
	{
		value: 'googleai/gemini-3.1-pro-preview',
		label: 'Gemini 3.1 Pro Preview',
		provider: 'googleai',
		component: 'llm-google-gemini'
	},
	{
		value: 'deepseek/default',
		label: 'DeepSeek Default',
		provider: 'deepseek',
		component: 'llm-deepseek'
	},
	{
		value: 'huggingface/meta-llama/Meta-Llama-3-8B',
		label: 'Meta Llama 3 8B',
		provider: 'huggingface',
		component: 'llm-huggingface-llama3'
	},
	{
		value: 'mistral/open-mistral-7b',
		label: 'Open Mistral 7B',
		provider: 'mistral',
		component: 'llm-mistral-open'
	},
	{
		value: 'echo/local',
		label: 'Local Echo',
		provider: 'echo',
		component: 'llm-echo'
	}
];

export const CUSTOM_AGENT_MODEL_SELECT_VALUE = '__custom_agent_model__';

const AGENT_MODEL_ALIASES: Record<string, string> = {
	'anthropic/claude-opus-4-7': 'anthropic/claude-opus-4-7',
	'claude-opus-4-7': 'anthropic/claude-opus-4-7',
	'anthropic/claude-opus-4-6': 'anthropic/claude-opus-4-7',
	'claude-opus-4-6': 'anthropic/claude-opus-4-7',
	'anthropic/claude-sonnet-4-6': 'anthropic/claude-sonnet-4-6',
	'claude-sonnet-4-6': 'anthropic/claude-sonnet-4-6',
	'anthropic/claude-haiku-4-5-20251001':
		'anthropic/claude-haiku-4-5-20251001',
	'claude-haiku-4-5-20251001': 'anthropic/claude-haiku-4-5-20251001',
	'anthropic/claude-haiku-4-5': 'anthropic/claude-haiku-4-5-20251001',
	'claude-haiku-4-5': 'anthropic/claude-haiku-4-5-20251001',
	'openai/gpt-5.4': 'openai/gpt-5.4',
	'gpt-5.4': 'openai/gpt-5.4',
	'openai/o3': 'openai/o3',
	o3: 'openai/o3',
	'googleai/gemini-3.1-pro-preview': 'googleai/gemini-3.1-pro-preview',
	'google/gemini-3.1-pro-preview': 'googleai/gemini-3.1-pro-preview',
	'gemini-3.1-pro-preview': 'googleai/gemini-3.1-pro-preview',
	'deepseek/default': 'deepseek/default',
	'huggingface/meta-llama/Meta-Llama-3-8B':
		'huggingface/meta-llama/Meta-Llama-3-8B',
	'meta-llama/Meta-Llama-3-8B': 'huggingface/meta-llama/Meta-Llama-3-8B',
	'mistral/open-mistral-7b': 'mistral/open-mistral-7b',
	'open-mistral-7b': 'mistral/open-mistral-7b',
	'echo/local': 'echo/local'
};

export function canonicalAgentModelSpec(
	value: string | null | undefined
): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return AGENT_MODEL_ALIASES[trimmed] ?? null;
}

export function agentModelOptionFor(
	value: string | null | undefined
): AgentModelOption | null {
	const canonical = canonicalAgentModelSpec(value);
	if (!canonical) return null;
	return AGENT_MODEL_OPTIONS.find((option) => option.value === canonical) ?? null;
}

export function agentModelLabel(value: string | null | undefined): string {
	const option = agentModelOptionFor(value);
	if (option) return option.label;
	const trimmed = typeof value === 'string' ? value.trim() : '';
	return trimmed || 'Select model';
}

export function agentModelSelectValue(value: string | null | undefined): string {
	return canonicalAgentModelSpec(value) ?? CUSTOM_AGENT_MODEL_SELECT_VALUE;
}

export function isSupportedAgentModelSpec(
	value: string | null | undefined
): boolean {
	return canonicalAgentModelSpec(value) !== null;
}

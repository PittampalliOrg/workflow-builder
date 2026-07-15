import { AGENT_MODEL_OPTIONS, type AgentModelOption } from './model-options';

/** A provider bucket in the agent model picker. Every provider that appears in
 * AGENT_MODEL_OPTIONS MUST be covered by exactly one group, or its models are
 * silently dropped from the selector (this is how GLM 5.2 went missing). The
 * `providersAreFullyGrouped` test guards that invariant. */
export type ModelGroup = {
	heading: string;
	providers: string[];
};

export const MODEL_GROUPS: ModelGroup[] = [
	{ heading: 'Anthropic', providers: ['anthropic'] },
	{ heading: 'OpenAI', providers: ['openai'] },
	{ heading: 'Microsoft Foundry', providers: ['foundry'] },
	{ heading: 'Together AI', providers: ['together'] },
	{ heading: 'NVIDIA NIM', providers: ['nvidia'] },
	{ heading: 'Google AI', providers: ['googleai'] },
	{ heading: 'Alibaba Cloud', providers: ['alibaba'] },
	{ heading: 'Z.AI', providers: ['zai'] },
	{ heading: 'DeepSeek', providers: ['deepseek'] },
	{ heading: 'Kimi', providers: ['kimi'] },
	{ heading: 'Open Models', providers: ['huggingface', 'mistral'] },
	{ heading: 'Local', providers: ['ollama', 'echo'] }
];

export type GroupedModelOptions = ModelGroup & { options: AgentModelOption[] };

/** Group the model catalog for display, dropping empty groups. */
export function groupModelOptions(
	options: readonly AgentModelOption[] = AGENT_MODEL_OPTIONS
): GroupedModelOptions[] {
	return MODEL_GROUPS.map((group) => ({
		...group,
		options: options.filter((option) => group.providers.includes(option.provider))
	})).filter((group) => group.options.length > 0);
}

/** Every provider covered by MODEL_GROUPS (deduped). */
export function groupedProviders(): Set<string> {
	return new Set(MODEL_GROUPS.flatMap((g) => g.providers));
}

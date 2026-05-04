/**
 * Per-million-token pricing for supported models. Mirrors the table shipped
 * in the claude-api skill cache and the public Anthropic pricing page.
 *
 * Keys match `AgentConfig.modelSpec` / the catalog `model_key`. Unknown
 * model keys fall back to `FALLBACK_PRICING` so cost totals never blow up.
 */

export type ModelPricing = {
	inputPerMillion: number;
	outputPerMillion: number;
	cacheReadPerMillion?: number;
	cacheWritePerMillion?: number;
};

export const MODEL_PRICING: Record<string, ModelPricing> = {
	// Claude Opus family
	"claude-opus-4-7": {
		inputPerMillion: 5.0,
		outputPerMillion: 25.0,
		cacheReadPerMillion: 0.5,
		cacheWritePerMillion: 6.25,
	},
	"claude-opus-4-6": {
		inputPerMillion: 5.0,
		outputPerMillion: 25.0,
		cacheReadPerMillion: 0.5,
		cacheWritePerMillion: 6.25,
	},
	"claude-opus-4-5": {
		inputPerMillion: 15.0,
		outputPerMillion: 75.0,
		cacheReadPerMillion: 1.5,
		cacheWritePerMillion: 18.75,
	},
	// Claude Sonnet family
	"claude-sonnet-4-6": {
		inputPerMillion: 3.0,
		outputPerMillion: 15.0,
		cacheReadPerMillion: 0.3,
		cacheWritePerMillion: 3.75,
	},
	"claude-sonnet-4-5": {
		inputPerMillion: 3.0,
		outputPerMillion: 15.0,
		cacheReadPerMillion: 0.3,
		cacheWritePerMillion: 3.75,
	},
	// Claude Haiku family
	"claude-haiku-4-5": {
		inputPerMillion: 1.0,
		outputPerMillion: 5.0,
		cacheReadPerMillion: 0.1,
		cacheWritePerMillion: 1.25,
	},
	"claude-haiku-4-5-20251001": {
		inputPerMillion: 1.0,
		outputPerMillion: 5.0,
		cacheReadPerMillion: 0.1,
		cacheWritePerMillion: 1.25,
	},
	// OpenAI + others (coarse — used when workflows run on non-Anthropic)
	"gpt-5": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
	"gpt-4o": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
	"gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
	"gemini-1.5-pro": { inputPerMillion: 1.25, outputPerMillion: 5.0 },
	// DeepSeek V4 direct API. Pro pricing reflects the 75% discount listed
	// through 2026-05-31 15:59 UTC on DeepSeek's pricing page.
	"deepseek/deepseek-v4-flash": {
		inputPerMillion: 0.14,
		outputPerMillion: 0.28,
		cacheReadPerMillion: 0.0028,
	},
	"deepseek-v4-flash": {
		inputPerMillion: 0.14,
		outputPerMillion: 0.28,
		cacheReadPerMillion: 0.0028,
	},
	"deepseek/deepseek-v4-pro": {
		inputPerMillion: 0.435,
		outputPerMillion: 0.87,
		cacheReadPerMillion: 0.003625,
	},
	"deepseek-v4-pro": {
		inputPerMillion: 0.435,
		outputPerMillion: 0.87,
		cacheReadPerMillion: 0.003625,
	},
};

export const FALLBACK_PRICING: ModelPricing = {
	inputPerMillion: 3.0,
	outputPerMillion: 15.0,
	cacheReadPerMillion: 0.3,
	cacheWritePerMillion: 3.75,
};

export type UsageTotals = {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreateTokens: number;
};

export function costFor(model: string | null | undefined, usage: UsageTotals): number {
	const price = (model && MODEL_PRICING[model]) || FALLBACK_PRICING;
	const input = (usage.inputTokens / 1_000_000) * price.inputPerMillion;
	const output = (usage.outputTokens / 1_000_000) * price.outputPerMillion;
	const cacheRead =
		((usage.cacheReadTokens ?? 0) / 1_000_000) *
		(price.cacheReadPerMillion ?? price.inputPerMillion * 0.1);
	const cacheWrite =
		((usage.cacheCreateTokens ?? 0) / 1_000_000) *
		(price.cacheWritePerMillion ?? price.inputPerMillion * 1.25);
	return input + output + cacheRead + cacheWrite;
}

export function formatCurrency(n: number): string {
	if (n < 0.01 && n > 0) return `<$0.01`;
	if (n >= 1000) return `$${n.toFixed(0)}`;
	return `$${n.toFixed(2)}`;
}

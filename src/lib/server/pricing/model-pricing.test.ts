import { describe, expect, it } from "vitest";
import { FALLBACK_PRICING, costFor, resolveModelPricing } from "./model-pricing";

describe("model pricing", () => {
	it("resolves exact, bare, provider-prefixed, and unknown model keys", () => {
		expect(resolveModelPricing("claude-opus-4-8")).toMatchObject({
			fallback: false,
			resolvedModel: "claude-opus-4-8",
			pricing: { inputPerMillion: 5, outputPerMillion: 25 },
		});
		expect(resolveModelPricing("anthropic/claude-opus-4-8")).toMatchObject({
			fallback: false,
			resolvedModel: "claude-opus-4-8",
			pricing: { inputPerMillion: 5, outputPerMillion: 25 },
		});
		expect(resolveModelPricing("kimi/kimi-k3")).toMatchObject({
			fallback: false,
			resolvedModel: "kimi/kimi-k3",
			pricing: {
				inputPerMillion: 3,
				outputPerMillion: 15,
				cacheReadPerMillion: 0.3,
			},
		});
		expect(resolveModelPricing("unknown/provider-model")).toEqual({
			fallback: true,
			resolvedModel: null,
			pricing: FALLBACK_PRICING,
		});
	});

	it("uses cache read and write rates when calculating cost", () => {
		expect(
			costFor("anthropic/claude-opus-4-8", {
				inputTokens: 1_000_000,
				outputTokens: 100_000,
				cacheReadTokens: 500_000,
				cacheCreateTokens: 200_000,
			}),
		).toBeCloseTo(9);
	});
});

import { describe, expect, it } from "vitest";
import {
	normalizeModelSpecForEnvironment,
	normalizeOpenAiChatModel,
} from "../src/service/model-normalization.js";

describe("model normalization", () => {
	it("keeps codex chat models unchanged", () => {
		const normalized = normalizeOpenAiChatModel("gpt-5.2-codex", "test", {
			logPrefix: "[test]",
		});
		expect(normalized).toBe("gpt-5.2-codex");
	});

	it("normalizes openai codex model specs", () => {
		const normalized = normalizeModelSpecForEnvironment(
			"openai/gpt-5.2-codex",
			{
				logPrefix: "[test]",
			},
		);
		expect(normalized).toBe("openai/gpt-5.2-codex");
	});

	it("normalizes provider-less model specs to openai/provider format", () => {
		const normalized = normalizeModelSpecForEnvironment("gpt-5.2-codex", {
			logPrefix: "[test]",
		});
		expect(normalized).toBe("openai/gpt-5.2-codex");
	});

	it("throws when anthropic spec is selected without an API key", () => {
		expect(() =>
			normalizeModelSpecForEnvironment("anthropic/claude-sonnet-4.5", {
				aiModel: "gpt-4.1",
				anthropicApiKey: "",
				logPrefix: "[test]",
			}),
		).toThrow(/requires ANTHROPIC_API_KEY/);
	});

	it("keeps anthropic spec when API key is provided", () => {
		const normalized = normalizeModelSpecForEnvironment(
			"anthropic/claude-sonnet-4.5",
			{
				anthropicApiKey: "present",
				logPrefix: "[test]",
			},
		);
		expect(normalized).toBe("anthropic/claude-sonnet-4.5");
	});

	it("throws when no model is configured", () => {
		expect(() =>
			normalizeModelSpecForEnvironment("", {
				aiModel: "",
				logPrefix: "[test]",
			}),
		).toThrow(/No OpenAI model configured/);
	});

	it("defaults empty model spec to normalized openai fallback", () => {
		const normalized = normalizeModelSpecForEnvironment("", {
			aiModel: "gpt-5.2-codex",
			logPrefix: "[test]",
		});
		expect(normalized).toBe("openai/gpt-5.2-codex");
	});
});

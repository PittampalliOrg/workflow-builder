import { describe, expect, it } from "vitest";
import {
	normalizeModelSpecForEnvironment,
	normalizeOpenAiChatModel,
} from "../src/service/model-normalization.js";

describe("model normalization", () => {
	it("falls back codex chat models to openai chat fallback", () => {
		const normalized = normalizeOpenAiChatModel("gpt-5.2-codex", "test", {
			fallbackModel: "gpt-4o",
			logPrefix: "[test]",
		});
		expect(normalized).toBe("gpt-4o");
	});

	it("normalizes openai codex model specs", () => {
		const normalized = normalizeModelSpecForEnvironment(
			"openai/gpt-5.2-codex",
			{
				fallbackModel: "gpt-4o-mini",
				logPrefix: "[test]",
			},
		);
		expect(normalized).toBe("openai/gpt-4o-mini");
	});

	it("normalizes provider-less model specs to openai/provider format", () => {
		const normalized = normalizeModelSpecForEnvironment("gpt-5.2-codex", {
			fallbackModel: "gpt-4o",
			logPrefix: "[test]",
		});
		expect(normalized).toBe("openai/gpt-4o");
	});

	it("falls back anthropic spec when API key is missing", () => {
		const normalized = normalizeModelSpecForEnvironment(
			"anthropic/claude-sonnet-4.5",
			{
				fallbackModel: "gpt-4o",
				aiModel: "gpt-4.1",
				anthropicApiKey: "",
				logPrefix: "[test]",
			},
		);
		expect(normalized).toBe("openai/gpt-4.1");
	});

	it("keeps anthropic spec when API key is provided", () => {
		const normalized = normalizeModelSpecForEnvironment(
			"anthropic/claude-sonnet-4.5",
			{
				fallbackModel: "gpt-4o",
				anthropicApiKey: "present",
				logPrefix: "[test]",
			},
		);
		expect(normalized).toBe("anthropic/claude-sonnet-4.5");
	});

	it("defaults empty model spec to normalized openai fallback", () => {
		const normalized = normalizeModelSpecForEnvironment("", {
			fallbackModel: "gpt-4o",
			aiModel: "gpt-5.2-codex",
			logPrefix: "[test]",
		});
		expect(normalized).toBe("openai/gpt-4o");
	});
});

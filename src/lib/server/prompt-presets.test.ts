import { describe, expect, it } from "vitest";
import {
	PromptPresetValidationError,
	normalizePromptPresetInput,
	promptParentFieldsFromMessages,
} from "./prompt-presets";

describe("normalizePromptPresetInput", () => {
	it("accepts MCP-style messages, arguments, and mustache format", () => {
		const normalized = normalizePromptPresetInput(
			{
				name: "Review",
				description: " Review code ",
				templateFormat: "mustache",
				messages: [
					{ role: "system", content: "Review {{args.ticket}}" },
					{ role: "user", content: "{{workflow.nodePrompt}}" },
				],
				arguments: [{ name: "ticket", description: "Ticket id", required: true }],
				metadata: { scope: "agent-editor" },
			},
			{ requireName: true },
		);

		expect(normalized.name).toBe("Review");
		expect(normalized.description).toBe("Review code");
		expect(normalized.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
		]);
		expect(normalized.arguments).toEqual([
			{ name: "ticket", description: "Ticket id", required: true },
		]);
		expect(normalized.templateFormat).toBe("mustache");
	});

	it("rejects unsupported template formats", () => {
		expect(() =>
			normalizePromptPresetInput(
				{
					name: "Unsafe",
					templateFormat: "jinja2",
					messages: [{ role: "system", content: "Hello" }],
				},
				{ requireName: true },
			),
		).toThrow(PromptPresetValidationError);
	});

	it("uses fallback values while preserving version payload validation", () => {
		const normalized = normalizePromptPresetInput(
			{ description: null },
			{
				requireName: false,
				fallback: {
					name: "Existing",
					description: "Existing description",
					messages: [{ role: "system", content: "Existing system" }],
					arguments: [],
					templateFormat: "mustache",
					metadata: null,
				},
			},
		);

		expect(normalized.name).toBe("Existing");
		expect(normalized.description).toBeNull();
		expect(normalized.messages).toEqual([
			{ role: "system", content: "Existing system" },
		]);
	});
});

describe("promptParentFieldsFromMessages", () => {
	it("does not duplicate a system-only preset into the legacy user prompt column", () => {
		expect(
			promptParentFieldsFromMessages([
				{ role: "system", content: "Stable system instructions" },
			]),
		).toEqual({
			systemPrompt: "Stable system instructions",
			userPrompt: null,
			promptMode: "system",
		});
	});

	it("captures user messages when the preset has one", () => {
		expect(
			promptParentFieldsFromMessages([
				{ role: "system", content: "Stable system instructions" },
				{ role: "user", content: "{{workflow.nodePrompt}}" },
			]),
		).toEqual({
			systemPrompt: "Stable system instructions",
			userPrompt: "{{workflow.nodePrompt}}",
			promptMode: "system+user",
		});
	});
});

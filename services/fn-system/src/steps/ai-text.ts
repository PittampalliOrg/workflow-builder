import { z } from "zod";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

export const AiTextInputSchema = z.object({
	provider: z.enum(["openai", "anthropic"]).default("openai"),
	model: z.string().min(1).default("gpt-4o"),
	prompt: z.string().min(1),
	systemPrompt: z.string().optional(),
	temperature: z.number().min(0).max(2).optional(),
	maxTokens: z.number().int().positive().optional(),
});

export type AiTextInput = z.infer<typeof AiTextInputSchema>;

function getLanguageModel(
	provider: string,
	model: string,
	credentials?: Record<string, string>,
) {
	switch (provider) {
		case "openai": {
			const apiKey = credentials?.OPENAI_API_KEY;
			if (!apiKey) throw new Error("Missing OPENAI_API_KEY credential");
			const openai = createOpenAI({ apiKey });
			return openai(model);
		}
		case "anthropic": {
			const apiKey = credentials?.ANTHROPIC_API_KEY;
			if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY credential");
			const anthropic = createAnthropic({ apiKey });
			return anthropic(model);
		}
		default:
			throw new Error(`Unsupported provider: ${provider}`);
	}
}

export async function aiTextStep(
	input: AiTextInput,
	credentials?: Record<string, string>,
): Promise<
	| {
			success: true;
			data: {
				text: string;
				usage: { promptTokens: number; completionTokens: number };
			};
	  }
	| { success: false; error: string }
> {
	try {
		const languageModel = getLanguageModel(
			input.provider,
			input.model,
			credentials,
		);

		const result = await generateText({
			model: languageModel,
			prompt: input.prompt,
			...(input.systemPrompt ? { system: input.systemPrompt } : {}),
			...(input.temperature != null ? { temperature: input.temperature } : {}),
			...(input.maxTokens != null ? { maxTokens: input.maxTokens } : {}),
		});

		return {
			success: true,
			data: {
				text: result.text,
				usage: {
					promptTokens: result.usage?.inputTokens ?? 0,
					completionTokens: result.usage?.outputTokens ?? 0,
				},
			},
		};
	} catch (err) {
		return {
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

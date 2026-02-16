import { z } from "zod";
import { generateObject } from "ai";
import { jsonSchema } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";

export const AiStructuredInputSchema = z.object({
	provider: z.enum(["openai", "anthropic"]).default("openai"),
	model: z.string().min(1).default("gpt-4o"),
	prompt: z.string().min(1),
	systemPrompt: z.string().optional(),
	schema: z.record(z.string(), z.unknown()),
	schemaName: z.string().optional(),
	temperature: z.number().min(0).max(2).optional(),
	maxTokens: z.number().int().positive().optional(),
});

/**
 * Convert schema-builder format to JSON Schema.
 * The UI schema-builder stores: [{id, name, type, description}, ...]
 * AI SDK expects: {type: "object", properties: {name: {type, description}}, required: [...]}
 */
export function normalizeSchema(raw: unknown): Record<string, unknown> {
	// If it's a string, try to parse it
	let parsed = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch {
			// Not valid JSON — return as-is wrapped in a schema
			return { type: "object", properties: {} };
		}
	}

	// If it's an array, it's the schema-builder format
	if (Array.isArray(parsed)) {
		const properties: Record<string, Record<string, unknown>> = {};
		const required: string[] = [];
		for (const item of parsed) {
			if (item && typeof item === "object" && item.name && item.type) {
				const prop: Record<string, unknown> = { type: item.type };
				if (item.description) prop.description = item.description;
				properties[item.name] = prop;
				required.push(item.name);
			}
		}
		return {
			type: "object",
			properties,
			required,
		};
	}

	// If it's already a JSON Schema object, return as-is
	if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
		return parsed as Record<string, unknown>;
	}

	return { type: "object", properties: {} };
}

export type AiStructuredInput = z.infer<typeof AiStructuredInputSchema>;

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

export async function aiStructuredStep(
	input: AiStructuredInput,
	credentials?: Record<string, string>,
): Promise<
	| {
			success: true;
			data: {
				object: unknown;
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

		const result = await generateObject({
			model: languageModel,
			prompt: input.prompt,
			...(input.systemPrompt ? { system: input.systemPrompt } : {}),
			...(input.temperature != null ? { temperature: input.temperature } : {}),
			...(input.maxTokens != null ? { maxTokens: input.maxTokens } : {}),
			schema: jsonSchema(input.schema),
			schemaName: input.schemaName,
		});

		return {
			success: true,
			data: {
				object: result.object,
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

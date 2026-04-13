import { z } from "zod";

const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HTTP_BASE_URL =
	process.env.DAPR_HTTP_BASE_URL || `http://127.0.0.1:${DAPR_HTTP_PORT}`;
const DEFAULT_TIMEOUT_MS = Number.parseInt(
	process.env.DAPR_CONVERSATION_TIMEOUT_MS || "600000",
	10,
);

const JsonObjectSchema = z
	.record(z.string(), z.unknown())
	.refine((value) => !Array.isArray(value), "Expected a JSON object");

const SimpleMessageSchema = z.object({
	role: z
		.enum(["developer", "system", "user", "assistant", "tool"])
		.default("user"),
	name: z.string().optional(),
	content: z.union([z.string(), z.array(z.unknown()), z.unknown()]),
	toolId: z.string().optional(),
	toolCallId: z.string().optional(),
	toolCalls: z.array(z.unknown()).optional(),
});

export const DaprConverseStructuredOutputInputSchema = z
	.object({
		componentName: z.string().trim().min(1),
		prompt: z.string().optional(),
		messages: z.array(z.union([SimpleMessageSchema, JsonObjectSchema])).optional(),
		responseFormat: JsonObjectSchema,
		model: z.string().trim().optional(),
		temperature: z.number().min(0).max(2).optional(),
		parameters: z.record(z.string(), z.unknown()).optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
		scrubPii: z.boolean().optional(),
		contextId: z.string().trim().optional(),
		promptCacheRetention: z.string().trim().optional(),
		tools: z.array(z.unknown()).optional(),
		toolChoice: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
		timeoutMs: z.number().int().positive().optional(),
	})
	.refine(
		(value) =>
			(typeof value.prompt === "string" && value.prompt.trim().length > 0) ||
			(Array.isArray(value.messages) && value.messages.length > 0),
		"Provide either prompt or messages",
	);

export type DaprConverseStructuredOutputInput = z.infer<
	typeof DaprConverseStructuredOutputInputSchema
>;

type StepResult =
	| { success: true; data: unknown }
	| { success: false; error: string };

function hasDaprRoleMessage(value: Record<string, unknown>): boolean {
	return (
		typeof value.ofDeveloper === "object" ||
		typeof value.ofSystem === "object" ||
		typeof value.ofUser === "object" ||
		typeof value.ofAssistant === "object" ||
		typeof value.ofTool === "object"
	);
}

function contentToDaprContent(content: unknown): unknown {
	if (Array.isArray(content)) return content;
	if (typeof content === "string") return [{ text: content }];
	return content;
}

function toDaprMessage(message: z.infer<typeof SimpleMessageSchema> | Record<string, unknown>) {
	if ("role" in message || "content" in message) {
		const simple = SimpleMessageSchema.parse(message);
		const base: Record<string, unknown> = {
			...(simple.name ? { name: simple.name } : {}),
			content: contentToDaprContent(simple.content),
		};

		if (simple.role === "assistant") {
			return {
				ofAssistant: {
					...base,
					...(simple.toolCalls ? { toolCalls: simple.toolCalls } : {}),
				},
			};
		}

		if (simple.role === "tool") {
			return {
				ofTool: {
					...base,
					...(simple.toolId || simple.toolCallId
						? { id: simple.toolId || simple.toolCallId }
						: {}),
				},
			};
		}

		const key =
			simple.role === "developer"
				? "ofDeveloper"
				: simple.role === "system"
					? "ofSystem"
					: "ofUser";
		return { [key]: base };
	}

	if (hasDaprRoleMessage(message)) {
		return message;
	}

	throw new Error(
		"Each message must either use { role, content } or a Dapr message object such as { ofUser: ... }",
	);
}

function buildMessages(input: DaprConverseStructuredOutputInput) {
	if (input.messages?.length) {
		return input.messages.map((message) =>
			toDaprMessage(message as Record<string, unknown>),
		);
	}
	return [
		{
			ofUser: {
				content: [{ text: input.prompt?.trim() ?? "" }],
			},
		},
	];
}

function buildDaprRequest(input: DaprConverseStructuredOutputInput) {
	const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
	if (input.model) metadata.model = input.model;

	return {
		...(input.contextId ? { contextId: input.contextId } : {}),
		inputs: [
			{
				messages: buildMessages(input),
				...(typeof input.scrubPii === "boolean"
					? { scrubPii: input.scrubPii }
					: {}),
			},
		],
		parameters: input.parameters ?? {},
		metadata,
		...(typeof input.scrubPii === "boolean" ? { scrubPii: input.scrubPii } : {}),
		...(typeof input.temperature === "number"
			? { temperature: input.temperature }
			: {}),
		...(input.tools ? { tools: input.tools } : {}),
		...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
		responseFormat: input.responseFormat,
		...(input.promptCacheRetention
			? { promptCacheRetention: input.promptCacheRetention }
			: {}),
	};
}

function parseJsonResponse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function extractTextContent(content: unknown): string | null {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const text = content
			.map((item) => {
				if (typeof item === "string") return item;
				if (item && typeof item === "object" && "text" in item) {
					const textValue = (item as { text?: unknown }).text;
					return typeof textValue === "string" ? textValue : "";
				}
				return "";
			})
			.join("");
		return text.length > 0 ? text : null;
	}
	return null;
}

function normalizeDaprResponse(raw: unknown) {
	const rawRecord =
		raw && typeof raw === "object" && !Array.isArray(raw)
			? (raw as Record<string, unknown>)
			: {};
	const output = Array.isArray(rawRecord.outputs) ? rawRecord.outputs[0] : null;
	const outputRecord =
		output && typeof output === "object" && !Array.isArray(output)
			? (output as Record<string, unknown>)
			: {};
	const choice = Array.isArray(outputRecord.choices)
		? outputRecord.choices[0]
		: null;
	const choiceRecord =
		choice && typeof choice === "object" && !Array.isArray(choice)
			? (choice as Record<string, unknown>)
			: {};
	const message =
		choiceRecord.message &&
		typeof choiceRecord.message === "object" &&
		!Array.isArray(choiceRecord.message)
			? (choiceRecord.message as Record<string, unknown>)
			: {};

	const text = extractTextContent(message.content);
	const structured =
		text !== null
			? parseJsonResponse(text)
			: message.content && typeof message.content === "object"
				? message.content
				: null;

	if (structured === null) {
		throw new Error("Dapr conversation response did not contain JSON content");
	}

	return {
		structured,
		text,
		raw,
		usage: outputRecord.usage ?? null,
		model: outputRecord.model ?? null,
		finishReason: choiceRecord.finishReason ?? null,
	};
}

export async function daprConverseStructuredOutputStep(
	input: DaprConverseStructuredOutputInput,
): Promise<StepResult> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(),
		input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	const url = `${DAPR_HTTP_BASE_URL}/v1.0-alpha2/conversation/${encodeURIComponent(input.componentName)}/converse`;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(buildDaprRequest(input)),
			signal: controller.signal,
		});
		const text = await response.text();
		const parsed = text ? parseJsonResponse(text) : {};

		if (!response.ok) {
			const detail =
				parsed && typeof parsed === "object"
					? JSON.stringify(parsed)
					: text || response.statusText;
			return {
				success: false,
				error: `Dapr conversation request failed with HTTP ${response.status}: ${detail}`,
			};
		}

		return { success: true, data: normalizeDaprResponse(parsed) };
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			return {
				success: false,
				error: `Dapr conversation request timed out after ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
			};
		}
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		clearTimeout(timeout);
	}
}

const structuredOutputInputSchema = {
	type: "object",
	required: ["prompt", "responseFormat"],
	properties: {
		componentName: {
			type: "string",
			description: "Dapr conversation component name.",
		},
		prompt: {
			type: "string",
			description: "User prompt to send when messages are not supplied.",
		},
		messages: {
			type: "array",
			description:
				"Optional Dapr Alpha2 messages, or simplified { role, content } messages.",
			items: { type: "object" },
		},
		responseFormat: {
			type: "object",
			description: "JSON Schema for the model response.",
			default: {
				type: "object",
				properties: {
					result: { type: "string" },
				},
				required: ["result"],
				additionalProperties: false,
			},
		},
		model: {
			type: "string",
			description: "Optional per-request model override.",
		},
		temperature: {
			type: "number",
			description: "Optional model temperature.",
			default: 0,
		},
		parameters: {
			type: "object",
			description: "Optional Dapr conversation parameters.",
		},
		metadata: {
			type: "object",
			description: "Optional component metadata overrides.",
		},
		scrubPii: {
			type: "boolean",
			description: "Ask Dapr to scrub PII.",
			default: false,
		},
		contextId: {
			type: "string",
			description: "Optional existing conversation context ID.",
		},
		promptCacheRetention: {
			type: "string",
			description: "Optional prompt cache retention duration.",
		},
	},
};

export const DAPR_CONVERSE_STRUCTURED_OUTPUT_ACTIONS = [
	{
		id: "system-dapr-converse-openai-structured",
		name: "system-dapr-converse-openai-structured",
		slug: "system/dapr-converse-structured-output",
		displayName: "OpenAI Structured Output",
		description:
			"Generate typed JSON with the Dapr OpenAI conversation component.",
		providerId: "system",
		providerLabel: "System",
		providerIconUrl: null,
		category: "LLM",
		service: "fn-system",
		runtime: "node-dapr-conversation",
		kind: "sw-function",
		visibility: "public-callable",
		sourceKind: "integration",
		auth: null,
		fields: null,
		tags: ["dapr", "conversation", "openai", "structured-output"],
		pieceName: "system",
		actionName: "dapr-converse-structured-output",
		version: "1.0.0",
		signature: {
			parameters: [],
			inputSchema: {
				...structuredOutputInputSchema,
				properties: {
					...structuredOutputInputSchema.properties,
					componentName: {
						...structuredOutputInputSchema.properties.componentName,
						default: "workflow-llm-openai",
					},
				},
			},
		},
		taskConfig: {
			call: "system/dapr-converse-structured-output",
			with: {
				body: {
					input: {
						componentName: "workflow-llm-openai",
						prompt: "",
						responseFormat:
							structuredOutputInputSchema.properties.responseFormat.default,
					},
				},
			},
		},
		definition: {
			call: "http",
			with: {
				method: "post",
				endpoint: {
					uri: "http://fn-system.workflow-builder.svc.cluster.local/execute",
				},
				body: {
					step: "dapr-converse-structured-output",
					input: {
						componentName: "workflow-llm-openai",
						prompt: "",
						responseFormat:
							structuredOutputInputSchema.properties.responseFormat.default,
					},
				},
			},
			input: {
				schema: { format: "json", document: structuredOutputInputSchema },
			},
		},
		swCompatibility: {
			status: "compatible",
			reasons: [],
			projection: {
				functionRefName: "system/dapr-converse-structured-output",
				call: "system/dapr-converse-structured-output",
				inputShape: "object",
			},
		},
	},
	{
		id: "system-dapr-converse-anthropic-structured",
		name: "system-dapr-converse-anthropic-structured",
		slug: "system/dapr-converse-structured-output",
		displayName: "Anthropic Structured Output",
		description:
			"Generate typed JSON with the Dapr Anthropic conversation component.",
		providerId: "system",
		providerLabel: "System",
		providerIconUrl: null,
		category: "LLM",
		service: "fn-system",
		runtime: "node-dapr-conversation",
		kind: "sw-function",
		visibility: "public-callable",
		sourceKind: "integration",
		auth: null,
		fields: null,
		tags: ["dapr", "conversation", "anthropic", "structured-output"],
		pieceName: "system",
		actionName: "dapr-converse-structured-output",
		version: "1.0.0",
		signature: {
			parameters: [],
			inputSchema: {
				...structuredOutputInputSchema,
				properties: {
					...structuredOutputInputSchema.properties,
					componentName: {
						...structuredOutputInputSchema.properties.componentName,
						default: "workflow-llm-anthropic",
					},
				},
			},
		},
		taskConfig: {
			call: "system/dapr-converse-structured-output",
			with: {
				body: {
					input: {
						componentName: "workflow-llm-anthropic",
						prompt: "",
						responseFormat:
							structuredOutputInputSchema.properties.responseFormat.default,
					},
				},
			},
		},
		definition: {
			call: "http",
			with: {
				method: "post",
				endpoint: {
					uri: "http://fn-system.workflow-builder.svc.cluster.local/execute",
				},
				body: {
					step: "dapr-converse-structured-output",
					input: {
						componentName: "workflow-llm-anthropic",
						prompt: "",
						responseFormat:
							structuredOutputInputSchema.properties.responseFormat.default,
					},
				},
			},
			input: {
				schema: { format: "json", document: structuredOutputInputSchema },
			},
		},
		swCompatibility: {
			status: "compatible",
			reasons: [],
			projection: {
				functionRefName: "system/dapr-converse-structured-output",
				call: "system/dapr-converse-structured-output",
				inputShape: "object",
			},
		},
	},
] as const;

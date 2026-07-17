import { z } from "zod";

const DAPR_HTTP_PORT = process.env.DAPR_HTTP_PORT || "3500";
const DAPR_HTTP_BASE_URL =
	process.env.DAPR_HTTP_BASE_URL || `http://127.0.0.1:${DAPR_HTTP_PORT}`;
const DEFAULT_TIMEOUT_MS = Number.parseInt(
	process.env.DAPR_CONVERSATION_TIMEOUT_MS || "600000",
	10,
);

const KIMI_K3_COMPONENT = "llm-kimi-k3";
const KIMI_K3_MODEL = "kimi-k3";
const KIMI_K3_REASONING_EFFORT = "max";
const KIMI_K3_MAX_COMPLETION_TOKENS = 131_072;
const PROTOBUF_STRING_VALUE =
	"type.googleapis.com/google.protobuf.StringValue";
const PROTOBUF_INT64_VALUE =
	"type.googleapis.com/google.protobuf.Int64Value";

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

function daprStringParameter(value: string) {
	return { "@type": PROTOBUF_STRING_VALUE, value };
}

function daprInt64Parameter(value: number) {
	return { "@type": PROTOBUF_INT64_VALUE, value: String(value) };
}

function parameterValue(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const wrapped = (value as Record<string, unknown>).value;
		return typeof wrapped === "string" ? wrapped : null;
	}
	return null;
}

function isKimiK3Request(input: DaprConverseStructuredOutputInput): boolean {
	const component = input.componentName.trim().toLowerCase();
	const requestedModel = (
		input.model ?? parameterValue(input.parameters?.model) ?? ""
	)
		.trim()
		.toLowerCase();
	return (
		component === KIMI_K3_COMPONENT ||
		requestedModel === KIMI_K3_MODEL ||
		requestedModel === `kimi/${KIMI_K3_MODEL}` ||
		requestedModel === `moonshot/${KIMI_K3_MODEL}`
	);
}

function kimiK3Parameters(): Record<string, unknown> {
	return {
		model: daprStringParameter(KIMI_K3_MODEL),
		reasoning_effort: daprStringParameter(KIMI_K3_REASONING_EFFORT),
		max_completion_tokens: daprInt64Parameter(
			KIMI_K3_MAX_COMPLETION_TOKENS,
		),
	};
}

export function buildDaprRequest(
	input: DaprConverseStructuredOutputInput,
) {
	const kimiK3 = isKimiK3Request(input);
	const model = kimiK3 ? KIMI_K3_MODEL : input.model;
	const metadata: Record<string, unknown> = { ...(input.metadata ?? {}) };
	if (kimiK3) delete metadata.model;
	else if (model) metadata.model = model;

	const parameters: Record<string, unknown> = { ...(input.parameters ?? {}) };
	if (model) parameters.model = daprStringParameter(model);
	if (kimiK3) {
		// K3 always reasons. Force its only supported effort and remove legacy K2
		// or fixed sampling fields that the K3 API rejects.
		delete parameters.thinking;
		delete parameters.thinking_level;
		delete parameters.reasoningEffort;
		delete parameters.max_tokens;
		delete parameters.temperature;
		delete parameters.top_p;
		delete parameters.n;
		delete parameters.presence_penalty;
		delete parameters.frequency_penalty;
		Object.assign(parameters, kimiK3Parameters());
	}

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
		parameters,
		metadata,
		...(typeof input.scrubPii === "boolean" ? { scrubPii: input.scrubPii } : {}),
		...(typeof input.temperature === "number" && !kimiK3
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

const {
	temperature: _kimiK3FixedTemperature,
	...kimiK3StructuredOutputProperties
} = structuredOutputInputSchema.properties;

const kimiK3StructuredOutputInputSchema = {
	...structuredOutputInputSchema,
	properties: {
		...kimiK3StructuredOutputProperties,
		componentName: {
			...structuredOutputInputSchema.properties.componentName,
			default: KIMI_K3_COMPONENT,
		},
		model: {
			...structuredOutputInputSchema.properties.model,
			default: KIMI_K3_MODEL,
		},
		parameters: {
			...structuredOutputInputSchema.properties.parameters,
			default: kimiK3Parameters(),
		},
	},
};

function kimiK3ActionInput() {
	return {
		componentName: KIMI_K3_COMPONENT,
		model: KIMI_K3_MODEL,
		parameters: kimiK3Parameters(),
		prompt: "",
		responseFormat: structuredOutputInputSchema.properties.responseFormat.default,
	};
}

export const DAPR_CONVERSE_STRUCTURED_OUTPUT_ACTIONS = [
	{
		id: "system-dapr-converse-kimi-k3-structured",
		name: "system-dapr-converse-kimi-k3-structured",
		slug: "system/dapr-converse-structured-output",
		displayName: "Kimi K3 Structured Output",
		description:
			"Generate typed JSON with Kimi K3 at maximum reasoning and its 1,048,576-token context window through Dapr.",
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
		tags: ["dapr", "conversation", "kimi", "kimi-k3", "structured-output"],
		pieceName: "system",
		actionName: "dapr-converse-structured-output",
		version: "1.0.0",
		signature: {
			parameters: [],
			inputSchema: kimiK3StructuredOutputInputSchema,
		},
		taskConfig: {
			call: "system/dapr-converse-structured-output",
			with: {
				body: {
					input: kimiK3ActionInput(),
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
					input: kimiK3ActionInput(),
				},
			},
			input: {
				schema: { format: "json", document: kimiK3StructuredOutputInputSchema },
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

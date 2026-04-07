import type { AgentWorkflowMessage } from "../types/state.js";
import type { ToolCall } from "../types/tool.js";
import type { LoopDeclarationOnlyTool, LoopToolChoice, LoopUsage } from "../types/loop-policy.js";

const ATTRIBUTE_MAX_CHARS = Math.max(
	1024,
	Number.parseInt(process.env.DURABLE_OTEL_ATTRIBUTE_MAX_CHARS ?? "12000", 10) ||
		12000,
);

export const OPENINFERENCE_SPAN_KIND = "openinference.span.kind";
export const OPENINFERENCE_LLM_KIND = "LLM";
export const OPENINFERENCE_TOOL_KIND = "TOOL";
export const AGENT_RUN_ID_ATTRIBUTE = "agent.run_id";

export interface JsonAttributeValue {
	value: string;
	truncated: boolean;
	originalLength: number;
}

interface NormalizedModelSpec {
	modelSpec?: string;
	provider?: string;
	modelName?: string;
}

interface NormalizedMessage {
	role: string;
	content: string | null;
	name?: string;
	toolCallId?: string;
	toolCalls?: ToolCall[];
	timestamp?: string;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch (error) {
		return JSON.stringify({
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

function truncateString(value: string, maxChars = ATTRIBUTE_MAX_CHARS): JsonAttributeValue {
	if (value.length <= maxChars) {
		return {
			value,
			truncated: false,
			originalLength: value.length,
		};
	}
	return {
		value: `${value.slice(0, maxChars)}... [truncated ${value.length - maxChars} chars]`,
		truncated: true,
		originalLength: value.length,
	};
}

export function toBoundedJsonAttribute(
	value: unknown,
	maxChars = ATTRIBUTE_MAX_CHARS,
): JsonAttributeValue {
	return truncateString(safeJsonStringify(value), maxChars);
}

function normalizeModelSpec(
	modelSpec: string | undefined,
): NormalizedModelSpec {
	const normalized = String(modelSpec ?? "").trim();
	if (!normalized) return {};
	const slashIndex = normalized.indexOf("/");
	if (slashIndex <= 0 || slashIndex === normalized.length - 1) {
		return {
			modelSpec: normalized,
			modelName: normalized,
		};
	}
	return {
		modelSpec: normalized,
		provider: normalized.slice(0, slashIndex),
		modelName: normalized.slice(slashIndex + 1),
	};
}

function normalizeMessages(messages: AgentWorkflowMessage[]): NormalizedMessage[] {
	return messages.map((message) => ({
		role: message.role,
		content: message.content,
		...(message.name ? { name: message.name } : {}),
		...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
		...(message.tool_calls?.length ? { toolCalls: message.tool_calls } : {}),
		...(message.timestamp ? { timestamp: message.timestamp } : {}),
	}));
}

export function buildLlmInputMessages(
	systemPrompt: string,
	preparedMessages: AgentWorkflowMessage[],
): NormalizedMessage[] {
	return [
		...(systemPrompt.trim()
			? [
					{
						role: "system",
						content: systemPrompt,
					} satisfies NormalizedMessage,
				]
			: []),
		...normalizeMessages(preparedMessages),
	];
}

export function buildLlmOutputMessages(
	content: string | null,
	toolCalls: ToolCall[] | undefined,
): NormalizedMessage[] {
	return [
		{
			role: "assistant",
			content,
			...(toolCalls?.length ? { toolCalls } : {}),
		},
	];
}

export function buildInvocationParameters(input: {
	toolChoice?: LoopToolChoice;
	activeToolNames: string[];
	declarationOnlyTools: LoopDeclarationOnlyTool[];
	approvalRequiredTools: Set<string>;
	appendInstructions?: string;
	modelSpec?: string;
	turn: number;
}): Record<string, unknown> {
	return {
		...(input.modelSpec ? { modelSpec: input.modelSpec } : {}),
		toolChoice: input.toolChoice ?? "auto",
		activeTools: input.activeToolNames,
		declarationOnlyTools: input.declarationOnlyTools.map((tool) => ({
			name: tool.name,
			...(tool.description ? { description: tool.description } : {}),
			approvalRequired: Boolean(tool.approvalRequired),
		})),
		approvalRequiredTools: [...input.approvalRequiredTools],
		...(input.appendInstructions?.trim()
			? { appendInstructions: input.appendInstructions.trim() }
			: {}),
		turn: input.turn,
	};
}

export function setBoundedJsonSpanAttribute(
	span: {
		setAttribute(key: string, value: string | number | boolean): void;
	},
	key: string,
	value: unknown,
): void {
	const bounded = toBoundedJsonAttribute(value);
	span.setAttribute(key, bounded.value);
	if (bounded.truncated) {
		span.setAttribute(`${key}.truncated`, true);
		span.setAttribute(`${key}.original_length`, bounded.originalLength);
	}
}

export function applyLlmSpanAttributes(input: {
	span: {
		setAttribute(key: string, value: string | number | boolean): void;
	};
	modelSpec?: string;
	defaultModelSpec?: string;
	inputMessages: AgentWorkflowMessage[];
	outputContent: string | null;
	outputToolCalls?: ToolCall[];
	systemPrompt: string;
	toolChoice?: LoopToolChoice;
	activeToolNames: string[];
	declarationOnlyTools: LoopDeclarationOnlyTool[];
	approvalRequiredTools: Set<string>;
	appendInstructions?: string;
	finishReason?: string;
	usage?: LoopUsage;
	agentRunId?: string;
	turn: number;
}): void {
	const modelInfo = normalizeModelSpec(input.modelSpec ?? input.defaultModelSpec);
	input.span.setAttribute(OPENINFERENCE_SPAN_KIND, OPENINFERENCE_LLM_KIND);
	if (input.agentRunId) {
		input.span.setAttribute(AGENT_RUN_ID_ATTRIBUTE, input.agentRunId);
	}
	if (modelInfo.provider) {
		input.span.setAttribute("llm.provider", modelInfo.provider);
	}
	if (modelInfo.modelName) {
		input.span.setAttribute("llm.model_name", modelInfo.modelName);
	}
	if (modelInfo.modelSpec) {
		input.span.setAttribute("llm.model_spec", modelInfo.modelSpec);
	}
	setBoundedJsonSpanAttribute(
		input.span,
		"llm.input_messages",
		buildLlmInputMessages(input.systemPrompt, input.inputMessages),
	);
	setBoundedJsonSpanAttribute(
		input.span,
		"llm.output_messages",
		buildLlmOutputMessages(input.outputContent, input.outputToolCalls),
	);
	setBoundedJsonSpanAttribute(
		input.span,
		"llm.invocation_parameters",
		buildInvocationParameters({
			toolChoice: input.toolChoice,
			activeToolNames: input.activeToolNames,
			declarationOnlyTools: input.declarationOnlyTools,
			approvalRequiredTools: input.approvalRequiredTools,
			appendInstructions: input.appendInstructions,
			modelSpec: modelInfo.modelSpec,
			turn: input.turn,
		}),
	);
	if (input.finishReason) {
		input.span.setAttribute("llm.finish_reason", input.finishReason);
	}
	if (typeof input.usage?.inputTokens === "number") {
		input.span.setAttribute("llm.token_count.prompt", input.usage.inputTokens);
	}
	if (typeof input.usage?.outputTokens === "number") {
		input.span.setAttribute(
			"llm.token_count.completion",
			input.usage.outputTokens,
		);
	}
	if (typeof input.usage?.totalTokens === "number") {
		input.span.setAttribute("llm.token_count.total", input.usage.totalTokens);
	}
}

export function applyToolSpanAttributes(input: {
	span: {
		setAttribute(key: string, value: string | number | boolean): void;
	};
	toolName: string;
	toolArguments: unknown;
	toolResult: unknown;
	agentRunId?: string;
}): void {
	input.span.setAttribute(OPENINFERENCE_SPAN_KIND, OPENINFERENCE_TOOL_KIND);
	input.span.setAttribute("tool.name", input.toolName);
	if (input.agentRunId) {
		input.span.setAttribute(AGENT_RUN_ID_ATTRIBUTE, input.agentRunId);
	}
	setBoundedJsonSpanAttribute(input.span, "tool.arguments", input.toolArguments);
	setBoundedJsonSpanAttribute(input.span, "tool.result", input.toolResult);
}

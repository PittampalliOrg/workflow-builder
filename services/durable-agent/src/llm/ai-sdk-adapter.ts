/**
 * AI SDK adapter — wraps streamText() for the durable agent workflow.
 * Mirrors Python call_llm activity at durable.py:1224-1325.
 *
 * Uses streamText() to emit real-time token events via the event bus,
 * then collects the full result for deterministic Dapr activity return.
 */

import { streamText, type LanguageModel } from "ai";
import type { AgentWorkflowMessage } from "../types/state.js";
import type { ToolCall } from "../types/tool.js";
import type { DurableAgentTool } from "../types/tool.js";
import type {
	LoopDeclarationOnlyTool,
	LoopToolChoice,
	LoopUsage,
} from "../types/loop-policy.js";
import { toAiSdkMessages } from "./message-converter.js";
import { buildToolDeclarations } from "./tool-declarations.js";
import { eventBus } from "../service/event-bus.js";

export interface LlmCallResult {
	role: "assistant";
	content: string | null;
	tool_calls?: ToolCall[];
	finish_reason?: string;
	usage?: LoopUsage;
	declared_tools?: Array<{
		name: string;
		executable: boolean;
		approvalRequired: boolean;
	}>;
}

/**
 * Per-call telemetry context passed from the workflow activity.
 */
export interface CallLlmOptions {
	instanceId?: string;
	turn?: number;
	agentName?: string;
	toolChoice?: LoopToolChoice;
	declarationOnlyTools?: LoopDeclarationOnlyTool[];
	approvalRequiredTools?: Set<string>;
}

/**
 * Call the LLM with streaming and return the complete assistant message.
 *
 * Token deltas are emitted as fire-and-forget events via the event bus
 * for real-time UI streaming. The full result is collected before returning
 * to maintain Dapr activity determinism on replay.
 *
 * @param model - AI SDK model instance
 * @param systemPrompt - System instructions
 * @param messages - Conversation history
 * @param tools - Available tools (schema-only declarations)
 * @param options - Optional telemetry metadata (instance, turn, agent name)
 */
export async function callLlmAdapter(
	model: LanguageModel,
	systemPrompt: string,
	messages: AgentWorkflowMessage[],
	tools: Record<string, DurableAgentTool>,
	options?: CallLlmOptions,
): Promise<LlmCallResult> {
	const coreMessages = toAiSdkMessages(messages);
	const declarationOnlyTools = options?.declarationOnlyTools ?? [];
	const toolDecls = buildToolDeclarations(tools, declarationOnlyTools);

	const hasTools = Object.keys(toolDecls).length > 0;
	const toolChoice = options?.toolChoice;
	const normalizedToolChoice =
		toolChoice === "auto" || toolChoice === "none" || toolChoice === "required"
			? toolChoice
			: toolChoice?.type === "tool"
				? { type: "tool" as const, toolName: toolChoice.toolName }
				: undefined;

	// Emit llm_start event
	eventBus.emitEvent("llm_start", {
		turn: options?.turn,
		instanceId: options?.instanceId,
	});

	const streamResult = streamText({
		model,
		system: systemPrompt,
		messages: coreMessages,
		tools: hasTools ? toolDecls : undefined,
		toolChoice: hasTools ? (normalizedToolChoice as any) : undefined,
		experimental_telemetry: {
			isEnabled: true,
			functionId: "durable-agent.callLlm",
			metadata: {
				...(options?.instanceId && {
					"workflow.instance_id": options.instanceId,
				}),
				...(options?.turn != null && { "agent.turn": String(options.turn) }),
				...(options?.agentName && { "agent.name": options.agentName }),
			},
		},
	});

	// Stream tokens via event bus (fire-and-forget side effects)
	for await (const chunk of streamResult.textStream) {
		if (chunk) {
			eventBus.emitEvent("llm_token", {
				token: chunk,
				turn: options?.turn,
				instanceId: options?.instanceId,
			});
		}
	}

	// Collect the full result (deterministic for Dapr replay)
	// After consuming textStream, await the collected properties
	const [text, finishReason, usage, toolCalls_raw] = await Promise.all([
		streamResult.text,
		streamResult.finishReason,
		streamResult.usage,
		streamResult.toolCalls,
	]);

	// Emit llm_end event
	eventBus.emitEvent("llm_end", {
		turn: options?.turn,
		instanceId: options?.instanceId,
		finishReason,
		usage,
	});

	// Build tool_calls array in OpenAI format
	let toolCalls: ToolCall[] | undefined;
	if (toolCalls_raw && toolCalls_raw.length > 0) {
		toolCalls = toolCalls_raw.map((tc: any) => ({
			id: tc.toolCallId,
			type: "function" as const,
			function: {
				name: tc.toolName,
				arguments: JSON.stringify(tc.args ?? tc.input ?? {}),
			},
		}));
	}

	const declaredTools: Array<{
		name: string;
		executable: boolean;
		approvalRequired: boolean;
	}> = [];
	const approvalRequiredTools =
		options?.approvalRequiredTools ?? new Set<string>();
	const declarationOnlyToolNames = new Set(
		declarationOnlyTools.map((tool) => tool.name),
	);
	for (const name of Object.keys(toolDecls)) {
		declaredTools.push({
			name,
			executable:
				!declarationOnlyToolNames.has(name) && Boolean(tools[name]?.execute),
			approvalRequired: approvalRequiredTools.has(name.toLowerCase()),
		});
	}

	return {
		role: "assistant",
		content: text || null,
		tool_calls: toolCalls,
		finish_reason: finishReason,
		usage: {
			inputTokens: usage?.inputTokens,
			outputTokens: usage?.outputTokens,
			totalTokens: usage?.totalTokens,
		},
		declared_tools: declaredTools,
	};
}

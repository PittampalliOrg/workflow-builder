/**
 * AI SDK adapter — wraps generateText() for the durable agent workflow.
 * Mirrors Python call_llm activity at durable.py:1224-1325.
 */

import { generateText, type LanguageModel } from "ai";
import type { AgentWorkflowMessage } from "../types/state.js";
import type { ToolCall } from "../types/tool.js";
import type { DurableAgentTool } from "../types/tool.js";
import { toAiSdkMessages } from "./message-converter.js";
import { buildToolDeclarations } from "./tool-declarations.js";

export interface LlmCallResult {
	role: "assistant";
	content: string | null;
	tool_calls?: ToolCall[];
}

/**
 * Per-call telemetry context passed from the workflow activity.
 */
export interface CallLlmOptions {
	instanceId?: string;
	turn?: number;
	agentName?: string;
}

/**
 * Call the LLM and return the assistant message.
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
	const toolDecls = buildToolDeclarations(tools);

	const hasTools = Object.keys(toolDecls).length > 0;

	const result = await generateText({
		model,
		system: systemPrompt,
		messages: coreMessages,
		tools: hasTools ? toolDecls : undefined,
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

	// Build tool_calls array in OpenAI format
	let toolCalls: ToolCall[] | undefined;
	if (result.toolCalls && result.toolCalls.length > 0) {
		toolCalls = result.toolCalls.map((tc: any) => ({
			id: tc.toolCallId,
			type: "function" as const,
			function: {
				name: tc.toolName,
				arguments: JSON.stringify(tc.args ?? tc.input ?? {}),
			},
		}));
	}

	return {
		role: "assistant",
		content: result.text || null,
		tool_calls: toolCalls,
	};
}

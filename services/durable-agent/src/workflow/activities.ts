/**
 * Dapr Workflow activities — all non-deterministic I/O.
 *
 * Activities are bound to the DurableAgent instance via closures in the
 * constructor, replacing the fragile `initActivities()` pattern.
 *
 * Mirrors Python durable.py:1171-1685.
 */

import type { WorkflowActivityContext } from "@dapr/dapr";
import { randomUUID } from "node:crypto";
import type { LanguageModel } from "ai";
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";

import type {
	AgentWorkflowMessage,
	ToolCall,
	ToolExecutionRecord,
	DurableAgentTool,
} from "../types/index.js";
import type {
	LoopDeclarationOnlyTool,
	LoopToolChoice,
} from "../types/loop-policy.js";
import type { DaprAgentState } from "../state/dapr-state.js";
import type { MemoryProvider } from "../memory/memory-base.js";
import { callLlmAdapter, type LlmCallResult } from "../llm/ai-sdk-adapter.js";
import {
	runInputProcessors,
	ProcessorAbortError,
	type ProcessorLike,
} from "../mastra/processor-adapter.js";

const tracer = trace.getTracer("durable-agent");

// --------------------------------------------------------------------------
// Payload types for activities
// --------------------------------------------------------------------------

export interface RecordInitialEntryPayload {
	instanceId: string;
	inputValue: string;
	source?: string;
	triggeringWorkflowInstanceId?: string;
	startTime?: string;
	traceContext?: Record<string, unknown>;
}

export interface CallLlmPayload {
	instanceId: string;
	task?: string;
	initialTask?: string;
	previousAssistantTurn?: {
		content?: string | null;
		toolCalls?: ToolCall[];
	};
	/**
	 * Tool results from the previous turn, passed from the generator.
	 * These are durably stored in Dapr's event log (activity outputs).
	 * Used to repair conversation state if a crash occurred between
	 * saveToolResults and the next callLlm (the Redis state may be
	 * missing tool results that were persisted by saveToolResults but
	 * lost due to the crash).
	 */
	previousToolResults?: Array<{
		role: string;
		content: string;
		tool_call_id: string;
		name: string;
	}>;
	modelSpec?: string;
	activeTools?: string[];
	toolChoice?: LoopToolChoice;
	trimMessagesTo?: number;
	truncateToolResultChars?: number;
	appendInstructions?: string;
	declarationOnlyTools?: LoopDeclarationOnlyTool[];
	approvalRequiredTools?: string[];
}

export interface RunToolPayload {
	toolCall: ToolCall;
	instanceId: string;
	order: number;
	workspaceRef?: string;
	executionId?: string;
}

export interface SaveToolResultsPayload {
	toolResults: Array<{
		role: string;
		content: string;
		tool_call_id: string;
		name: string;
	}>;
	instanceId: string;
}

export interface CompactConversationPayload {
	instanceId: string;
	reason?: string;
	preserveRecentMessages?: number;
	minMessagesToCompact?: number;
	maxSummaryItems?: number;
}

export interface CompactConversationResult {
	applied: boolean;
	reason: string;
	beforeMessages: number;
	afterMessages: number;
	preservedMessages: number;
	summarizedMessages: number;
}

export interface BroadcastPayload {
	message: Record<string, unknown>;
}

export interface SendResponseBackPayload {
	response: Record<string, unknown>;
	targetAgent: string;
	targetInstanceId: string;
}

export interface FinalizeWorkflowPayload {
	instanceId: string;
	finalOutput?: string;
	endTime?: string;
	triggeringWorkflowInstanceId?: string;
}

export type GetAvailableAgentsPayload = {};

function messageFromError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err ?? "");
}

function isContextOverflowError(err: unknown): boolean {
	const message = messageFromError(err).toLowerCase();
	return (
		message.includes("context_length_exceeded") ||
		message.includes("maximum context length") ||
		message.includes("context window") ||
		message.includes("too many tokens") ||
		message.includes("prompt is too long") ||
		message.includes("prompt_tokens") ||
		message.includes("input is too large")
	);
}

function normalizeConversationHistory(messages: AgentWorkflowMessage[]): {
	messages: AgentWorkflowMessage[];
	removedOrphanTools: number;
	removedBrokenTurns: number;
} {
	const normalized: AgentWorkflowMessage[] = [];
	let removedOrphanTools = 0;
	let removedBrokenTurns = 0;

	for (let index = 0; index < messages.length; ) {
		const message = messages[index];
		if (message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0) {
			const expectedToolCallIds = new Set(
				(message.tool_calls ?? []).map((toolCall) => toolCall.id),
			);
			const toolMessages: AgentWorkflowMessage[] = [];
			let cursor = index + 1;
			while (cursor < messages.length && messages[cursor]?.role === "tool") {
				toolMessages.push(messages[cursor]!);
				cursor += 1;
			}
			const seenToolIds = new Set(
				toolMessages
					.map((toolMessage) => toolMessage.tool_call_id)
					.filter((toolCallId): toolCallId is string => Boolean(toolCallId)),
			);
			const missingToolIds = [...expectedToolCallIds].filter(
				(toolCallId) => !seenToolIds.has(toolCallId),
			);
			if (missingToolIds.length > 0) {
				removedBrokenTurns += 1 + toolMessages.length;
				index = cursor;
				continue;
			}
			normalized.push(message);
			for (const toolMessage of toolMessages) {
				if (
					toolMessage.tool_call_id &&
					expectedToolCallIds.has(toolMessage.tool_call_id)
				) {
					normalized.push(toolMessage);
				} else {
					removedOrphanTools += 1;
				}
			}
			index = cursor;
			continue;
		}

		if (message.role === "tool") {
			removedOrphanTools += 1;
			index += 1;
			continue;
		}

		normalized.push(message);
		index += 1;
	}

	return { messages: normalized, removedOrphanTools, removedBrokenTurns };
}

// --------------------------------------------------------------------------
// Activity factory functions
// --------------------------------------------------------------------------

/**
 * Create the recordInitialEntry activity bound to the agent.
 * Mirrors Python record_initial_entry at durable.py:1171-1222.
 */
export function createRecordInitialEntry(stateManager: DaprAgentState) {
	return async function recordInitialEntry(
		_ctx: WorkflowActivityContext,
		payload: RecordInitialEntryPayload,
	): Promise<void> {
		const state = await stateManager.ensureInstance(
			payload.instanceId,
			payload.inputValue,
			payload.triggeringWorkflowInstanceId,
		);
		const entry = state.instances[payload.instanceId];
		if (!entry) return;

		entry.source = payload.source ?? "direct";
		if (payload.startTime) entry.start_time = payload.startTime;
		if (payload.triggeringWorkflowInstanceId) {
			entry.triggering_workflow_instance_id =
				payload.triggeringWorkflowInstanceId;
		}
		if (payload.traceContext) {
			entry.trace_context = payload.traceContext;
		}
		entry.status = "running";
		await stateManager.saveState(state);

		console.log(
			`[recordInitialEntry] instance=${payload.instanceId} input="${payload.inputValue}"`,
		);
	};
}

/**
 * Create the callLlm activity bound to the agent.
 * Mirrors Python call_llm at durable.py:1224-1325.
 */
export function createCallLlm(
	stateManager: DaprAgentState,
	model: LanguageModel,
	systemPrompt: string,
	tools: Record<string, DurableAgentTool>,
	memory: MemoryProvider,
	processors?: ProcessorLike[],
	agentName?: string,
	resolveModelSpec?: (modelSpec: string) => LanguageModel,
) {
	let turnCount = 0;

	return async function callLlm(
		_ctx: WorkflowActivityContext,
		payload: CallLlmPayload,
	): Promise<LlmCallResult> {
		turnCount++;
		let state = await stateManager.loadState();
		let entry = state.instances[payload.instanceId];
		if (!entry) {
			// Defensive self-heal: concurrent state writes can drop an instance entry.
			// Recreate the entry instead of crashing the workflow turn.
			console.warn(
				`[callLlm] Missing state entry for instance=${payload.instanceId}; recreating`,
			);
			state = await stateManager.ensureInstance(
				payload.instanceId,
				payload.initialTask ?? payload.task ?? "Recovered workflow state",
			);
			entry = state.instances[payload.instanceId];
			if (!entry) {
				throw new Error(
					`Failed to recover state entry for instance ${payload.instanceId}`,
				);
			}
		}

		// On the first turn, prepend the user's task as a user message
		if (payload.task) {
			// Guard against duplicate user messages on crash-retry
			const alreadyHasTask = entry.messages.some(
				(m) => m.role === "user" && m.content === payload.task,
			);
			if (!alreadyHasTask) {
				const userMsg: AgentWorkflowMessage = {
					id: randomUUID(),
					role: "user",
					content: payload.task,
					timestamp: new Date().toISOString(),
				};
				entry.messages.push(userMsg);
				entry.last_message = userMsg;

				// Also persist to memory
				memory.addMessage({
					role: "user",
					content: payload.task,
				});
			}
		}

		// Repair conversation state after crash recovery.
		// If any assistant message with tool_calls lacks corresponding tool results,
		// inject them from the generator's durable activity outputs.
		const previousAssistantToolCalls =
			payload.previousAssistantTurn?.toolCalls?.filter(
				(toolCall): toolCall is ToolCall => Boolean(toolCall?.id),
			) ?? [];
		if (previousAssistantToolCalls.length > 0) {
			const expectedIds = new Set(
				previousAssistantToolCalls.map((toolCall) => toolCall.id),
			);
			const hasMatchingAssistantTurn = entry.messages.some(
				(message) =>
					message.role === "assistant" &&
					(message.tool_calls?.some((toolCall) =>
						expectedIds.has(toolCall.id),
					) ??
						false),
			);
			if (!hasMatchingAssistantTurn) {
				const firstMatchingToolIndex = entry.messages.findIndex(
					(message) =>
						message.role === "tool" &&
						Boolean(
							message.tool_call_id && expectedIds.has(message.tool_call_id),
						),
				);
				const repairedAssistantTurn: AgentWorkflowMessage = {
					id: randomUUID(),
					role: "assistant",
					content: payload.previousAssistantTurn?.content ?? null,
					tool_calls: previousAssistantToolCalls,
					timestamp: new Date().toISOString(),
				};
				if (firstMatchingToolIndex >= 0) {
					// Preserve assistant -> tool ordering when the tool results survived
					// but the assistant tool-call turn was lost during state recovery.
					entry.messages.splice(
						firstMatchingToolIndex,
						0,
						repairedAssistantTurn,
					);
				} else {
					entry.messages.push(repairedAssistantTurn);
				}
				entry.last_message = repairedAssistantTurn;
				console.log(
					`[callLlm] Repaired missing assistant tool-call turn for instance=${payload.instanceId}`,
				);
			}
		}
		if (payload.previousToolResults?.length) {
			console.log(
				`[callLlm] previousToolResults provided: ${payload.previousToolResults.length} result(s), ids=[${payload.previousToolResults.map((t) => t.tool_call_id).join(",")}]`,
			);

			const existingToolResultIds = new Set(
				entry.messages
					.filter((m) => m.role === "tool" && m.tool_call_id)
					.map((m) => m.tool_call_id),
			);

			let repaired = 0;
			for (const tr of payload.previousToolResults) {
				if (!existingToolResultIds.has(tr.tool_call_id)) {
					const msg: AgentWorkflowMessage = {
						id: randomUUID(),
						role: "tool",
						content: tr.content,
						tool_call_id: tr.tool_call_id,
						name: tr.name,
						timestamp: new Date().toISOString(),
					};
					entry.messages.push(msg);
					entry.last_message = msg;
					repaired++;
				}
			}

			if (repaired > 0) {
				console.log(
					`[callLlm] Repaired ${repaired} missing tool result(s) from durable activity outputs`,
				);
				await stateManager.saveState(state);
			}
		}

		const normalizedConversation = normalizeConversationHistory(entry.messages);
		if (
			normalizedConversation.removedBrokenTurns > 0 ||
			normalizedConversation.removedOrphanTools > 0
		) {
			if (normalizedConversation.removedBrokenTurns > 0) {
				console.warn(
					`[callLlm] Removed ${normalizedConversation.removedBrokenTurns} message(s) from broken assistant tool-call turns before LLM call`,
				);
			}
			if (normalizedConversation.removedOrphanTools > 0) {
				console.warn(
					`[callLlm] Dropped ${normalizedConversation.removedOrphanTools} orphan tool message(s) before LLM call`,
				);
			}
			entry.messages = normalizedConversation.messages;
			entry.last_message =
				entry.messages.length > 0
					? entry.messages[entry.messages.length - 1]
					: null;
			await stateManager.saveState(state);
		}

		if (entry.messages.length === 0) {
			const recoveryMessage: AgentWorkflowMessage = {
				id: randomUUID(),
				role: "user",
				content:
					payload.initialTask ||
					payload.task ||
					(entry.input_value && entry.input_value !== "Recovered workflow state"
						? entry.input_value
						: "Continue the task using the current repository state."),
				timestamp: new Date().toISOString(),
			};
			console.warn(
				`[callLlm] Reconstructed fallback conversation state for instance=${payload.instanceId}`,
			);
			entry.messages = [recoveryMessage];
			entry.last_message = recoveryMessage;
			await stateManager.saveState(state);
		}

		// Run pre-LLM processors (guardrails) if configured
		let processedMessages = entry.messages;
		if (processors && processors.length > 0) {
			try {
				processedMessages = await runInputProcessors(
					processors,
					entry.messages,
				);
				if (processedMessages.length !== entry.messages.length) {
					console.log(
						`[callLlm] Processors modified message count: ${entry.messages.length} -> ${processedMessages.length}`,
					);
				}
			} catch (err) {
				if (err instanceof ProcessorAbortError) {
					console.warn(
						`[callLlm] Processor "${err.processorId}" aborted: ${err.message}`,
					);
					// Return a rejection message instead of calling the LLM
					return {
						role: "assistant" as const,
						content: `Request blocked by safety processor "${err.processorId}": ${err.message}`,
					};
				}
				throw err;
			}
		}

		let preparedMessages = processedMessages;
		const trimMessagesTo =
			typeof payload.trimMessagesTo === "number" &&
			Number.isFinite(payload.trimMessagesTo)
				? Math.max(1, Math.floor(payload.trimMessagesTo))
				: undefined;
		if (trimMessagesTo && preparedMessages.length > trimMessagesTo) {
			preparedMessages = preparedMessages.slice(-trimMessagesTo);
		}

		const truncateToolResultChars =
			typeof payload.truncateToolResultChars === "number" &&
			Number.isFinite(payload.truncateToolResultChars)
				? Math.max(64, Math.floor(payload.truncateToolResultChars))
				: undefined;
		if (truncateToolResultChars) {
			preparedMessages = preparedMessages.map((msg) => {
				if (msg.role !== "tool" || typeof msg.content !== "string") {
					return msg;
				}
				if (msg.content.length <= truncateToolResultChars) {
					return msg;
				}
				return {
					...msg,
					content:
						msg.content.slice(0, truncateToolResultChars) +
						`... [truncated ${msg.content.length - truncateToolResultChars} chars]`,
				};
			});
		}

		let activeTools = tools;
		const activeToolNames = Array.isArray(payload.activeTools)
			? payload.activeTools
					.map((name) => (typeof name === "string" ? name.trim() : ""))
					.filter((name) => Boolean(name))
			: [];
		if (activeToolNames.length > 0) {
			const allowed = new Set(activeToolNames);
			activeTools = {};
			for (const [toolName, toolDef] of Object.entries(tools)) {
				if (allowed.has(toolName)) {
					activeTools[toolName] = toolDef;
				}
			}
		}

		const declarationOnlyTools = Array.isArray(payload.declarationOnlyTools)
			? payload.declarationOnlyTools.filter(
					(entry): entry is LoopDeclarationOnlyTool =>
						Boolean(entry?.name && typeof entry.name === "string"),
				)
			: [];
		const approvalRequiredTools = new Set(
			Array.isArray(payload.approvalRequiredTools)
				? payload.approvalRequiredTools
						.map((name) =>
							typeof name === "string" ? name.trim().toLowerCase() : "",
						)
						.filter((name) => Boolean(name))
				: [],
		);
		const effectiveModel =
			typeof payload.modelSpec === "string" &&
			payload.modelSpec.trim() &&
			resolveModelSpec
				? resolveModelSpec(payload.modelSpec.trim())
				: model;
		const effectiveSystemPrompt =
			typeof payload.appendInstructions === "string" &&
			payload.appendInstructions.trim()
				? `${systemPrompt}\n\n## Step Instructions\n${payload.appendInstructions.trim()}`
				: systemPrompt;

		// Call LLM with tool declarations (no auto-execute)
		let result: LlmCallResult;
		try {
			result = await callLlmAdapter(
				effectiveModel,
				effectiveSystemPrompt,
				preparedMessages,
				activeTools,
				{
					instanceId: payload.instanceId,
					turn: turnCount,
					agentName,
					toolChoice: payload.toolChoice,
					declarationOnlyTools,
					approvalRequiredTools,
				},
			);
		} catch (err) {
			if (isContextOverflowError(err)) {
				throw new Error(`CONTEXT_OVERFLOW:${messageFromError(err)}`);
			}
			throw err;
		}

		// Build and persist assistant message
		const assistantMsg: AgentWorkflowMessage = {
			id: randomUUID(),
			role: "assistant",
			content: result.content,
			tool_calls: result.tool_calls,
			timestamp: new Date().toISOString(),
		};
		entry.messages.push(assistantMsg);
		entry.last_message = assistantMsg;
		await stateManager.saveState(state);

		// Also persist to memory
		memory.addMessage({
			role: "assistant",
			content: result.content ?? "",
		});

		console.log(
			`[callLlm] instance=${payload.instanceId} text=${(result.content ?? "").slice(0, 80)} toolCalls=${result.tool_calls?.length ?? 0}`,
		);

		return result;
	};
}

/**
 * Create the runTool activity bound to the agent.
 * Mirrors Python run_tool at durable.py:1327-1369.
 */
export function createRunTool(tools: Record<string, DurableAgentTool>) {
	return async function runTool(
		_ctx: WorkflowActivityContext,
		payload: RunToolPayload,
	): Promise<{
		role: string;
		content: string;
		tool_call_id: string;
		name: string;
	}> {
		const { toolCall } = payload;
		const fnName = toolCall.function.name;
		const tool = tools[fnName];

		if (!tool) {
			const errMsg = `Unknown tool: ${fnName}`;
			console.error(`[runTool] ${errMsg}`);
			return {
				role: "tool",
				content: JSON.stringify({ error: errMsg }),
				tool_call_id: toolCall.id,
				name: fnName,
			};
		}
		if (typeof tool.execute !== "function") {
			const errMsg = `Tool has no execute handler: ${fnName}`;
			console.warn(`[runTool] ${errMsg}`);
			return {
				role: "tool",
				content: JSON.stringify({ error: errMsg }),
				tool_call_id: toolCall.id,
				name: fnName,
			};
		}

		return tracer.startActiveSpan(
			`execute_tool ${fnName}`,
			{
				kind: SpanKind.INTERNAL,
				attributes: {
					"gen_ai.operation.name": "execute_tool",
					"gen_ai.tool.name": fnName,
					"gen_ai.tool.call.arguments": toolCall.function.arguments,
				},
			},
			async (span) => {
				const args = JSON.parse(toolCall.function.arguments);
				const shouldAnnotateWorkspaceContext =
					fnName === "read_file" ||
					fnName === "write_file" ||
					fnName === "edit_file" ||
					fnName === "list_files" ||
					fnName === "delete_file" ||
					fnName === "mkdir" ||
					fnName === "file_stat" ||
					fnName === "execute_command" ||
					fnName.startsWith("mastra_workspace_");
				const enrichedArgs =
					shouldAnnotateWorkspaceContext && args && typeof args === "object"
						? {
								...(args as Record<string, unknown>),
								__durable_instance_id: payload.instanceId,
								...(payload.workspaceRef
									? { workspaceRef: payload.workspaceRef }
									: {}),
								...(payload.executionId
									? { executionId: payload.executionId }
									: {}),
							}
						: args;
				let result: unknown;
				try {
					result = await tool.execute!(enrichedArgs);
					span.setAttribute(
						"gen_ai.tool.call.result",
						JSON.stringify(result).slice(0, 4096),
					);
					span.setStatus({ code: SpanStatusCode.OK });
				} catch (err) {
					result = { error: String(err) };
					span.setStatus({
						code: SpanStatusCode.ERROR,
						message: String(err),
					});
				} finally {
					span.end();
				}

				console.log(
					`[runTool] tool=${fnName} call_id=${toolCall.id} result=${JSON.stringify(result).slice(0, 120)}`,
				);

				return {
					role: "tool",
					content: JSON.stringify(result),
					tool_call_id: toolCall.id,
					name: fnName,
				};
			},
		);
	};
}

/**
 * Create the saveToolResults activity bound to the agent.
 * Mirrors Python save_tool_results at durable.py:1371-1424.
 */
export function createSaveToolResults(
	stateManager: DaprAgentState,
	memory: MemoryProvider,
) {
	return async function saveToolResults(
		_ctx: WorkflowActivityContext,
		payload: SaveToolResultsPayload,
	): Promise<void> {
		let state = await stateManager.loadState();
		let entry = state.instances[payload.instanceId];
		if (!entry) {
			console.warn(
				`[saveToolResults] Missing state entry for instance=${payload.instanceId}; recreating`,
			);
			state = await stateManager.ensureInstance(
				payload.instanceId,
				"Recovered workflow state",
			);
			entry = state.instances[payload.instanceId];
			if (!entry) {
				throw new Error(
					`Failed to recover state entry for instance ${payload.instanceId}`,
				);
			}
		}

		// Deduplicate by tool_call_id to guard against replays
		const existingIds = new Set(
			entry.messages
				.filter((m) => m.role === "tool" && m.tool_call_id)
				.map((m) => m.tool_call_id),
		);

		for (const tr of payload.toolResults) {
			if (existingIds.has(tr.tool_call_id)) {
				console.log(
					`[saveToolResults] skipping duplicate tool_call_id=${tr.tool_call_id}`,
				);
				continue;
			}

			const msg: AgentWorkflowMessage = {
				id: randomUUID(),
				role: "tool",
				content: tr.content,
				tool_call_id: tr.tool_call_id,
				name: tr.name,
				timestamp: new Date().toISOString(),
			};
			entry.messages.push(msg);
			entry.last_message = msg;

			// Record in tool_history for audit
			const record: ToolExecutionRecord = {
				id: randomUUID(),
				timestamp: new Date().toISOString(),
				tool_call_id: tr.tool_call_id,
				tool_name: tr.name,
				tool_args: {},
				execution_result: tr.content,
			};
			entry.tool_history.push(record);

			// Persist to memory
			memory.addMessage({
				role: "tool",
				content: tr.content,
				name: tr.name,
				tool_call_id: tr.tool_call_id,
			});
		}

		await stateManager.saveState(state);
		console.log(
			`[saveToolResults] instance=${payload.instanceId} saved ${payload.toolResults.length} result(s)`,
		);
	};
}

function buildCompactSummary(input: {
	reason: string;
	summarizedMessages: AgentWorkflowMessage[];
	maxSummaryItems: number;
}): string {
	const { reason, summarizedMessages, maxSummaryItems } = input;
	const firstUser = summarizedMessages.find(
		(msg) =>
			msg.role === "user" && typeof msg.content === "string" && msg.content,
	);
	const assistantNotes = summarizedMessages
		.filter(
			(msg) =>
				msg.role === "assistant" &&
				typeof msg.content === "string" &&
				msg.content.trim(),
		)
		.slice(-maxSummaryItems)
		.map((msg) => `- ${msg.content!.trim().slice(0, 220)}`);
	const toolNames = [
		...new Set(
			summarizedMessages
				.filter((msg) => msg.role === "tool" && msg.name)
				.map((msg) => msg.name as string),
		),
	];
	const toolSummary =
		toolNames.length > 0
			? `Tools used: ${toolNames.slice(0, maxSummaryItems).join(", ")}`
			: "Tools used: none";
	const lines = [
		`Conversation compacted (${reason}). Preserve this summary as authoritative context.`,
		firstUser?.content
			? `Original task: ${firstUser.content.trim().slice(0, 400)}`
			: "Original task: unavailable",
		toolSummary,
	];
	if (assistantNotes.length > 0) {
		lines.push("Key assistant points:");
		lines.push(...assistantNotes);
	}
	return lines.join("\n");
}

/**
 * Compact historical conversation into a synthetic summary message while
 * preserving the most recent N messages verbatim.
 */
export function createCompactConversation(stateManager: DaprAgentState) {
	return async function compactConversation(
		_ctx: WorkflowActivityContext,
		payload: CompactConversationPayload,
	): Promise<CompactConversationResult> {
		let state = await stateManager.loadState();
		let entry = state.instances[payload.instanceId];
		if (!entry) {
			state = await stateManager.ensureInstance(
				payload.instanceId,
				"Recovered workflow state",
			);
			entry = state.instances[payload.instanceId];
			if (!entry) {
				throw new Error(
					`Failed to recover state entry for instance ${payload.instanceId}`,
				);
			}
		}

		const preserveRecentMessages =
			typeof payload.preserveRecentMessages === "number"
				? Math.max(1, Math.floor(payload.preserveRecentMessages))
				: 8;
		const minMessagesToCompact =
			typeof payload.minMessagesToCompact === "number"
				? Math.max(0, Math.floor(payload.minMessagesToCompact))
				: 6;
		const maxSummaryItems =
			typeof payload.maxSummaryItems === "number"
				? Math.max(1, Math.floor(payload.maxSummaryItems))
				: 12;
		const reason = payload.reason?.trim() || "automatic";

		const beforeMessages = entry.messages.length;
		const compactableCount = beforeMessages - preserveRecentMessages;
		if (beforeMessages === 0 || compactableCount < minMessagesToCompact) {
			return {
				applied: false,
				reason,
				beforeMessages,
				afterMessages: beforeMessages,
				preservedMessages: Math.min(beforeMessages, preserveRecentMessages),
				summarizedMessages: 0,
			};
		}

		const splitIndex = Math.max(0, beforeMessages - preserveRecentMessages);
		const summarizedMessages = entry.messages.slice(0, splitIndex);
		const preservedTail = entry.messages.slice(splitIndex);
		const summaryContent = buildCompactSummary({
			reason,
			summarizedMessages,
			maxSummaryItems,
		});
		const summaryMsg: AgentWorkflowMessage = {
			id: randomUUID(),
			role: "system",
			content: summaryContent,
			timestamp: new Date().toISOString(),
		};
		entry.messages = [summaryMsg, ...preservedTail];
		entry.last_message =
			entry.messages[entry.messages.length - 1] ?? summaryMsg;
		await stateManager.saveState(state);

		const afterMessages = entry.messages.length;
		console.log(
			`[compactConversation] instance=${payload.instanceId} reason=${reason} before=${beforeMessages} after=${afterMessages}`,
		);

		return {
			applied: true,
			reason,
			beforeMessages,
			afterMessages,
			preservedMessages: preservedTail.length,
			summarizedMessages: summarizedMessages.length,
		};
	};
}

/**
 * Create the finalizeWorkflow activity bound to the agent.
 * Mirrors Python finalize_workflow at durable.py:1505-1538.
 */
export function createFinalizeWorkflow(stateManager: DaprAgentState) {
	return async function finalizeWorkflow(
		_ctx: WorkflowActivityContext,
		payload: FinalizeWorkflowPayload,
	): Promise<void> {
		const state = await stateManager.loadState();
		const entry = state.instances[payload.instanceId];
		if (!entry) return;

		entry.status = payload.finalOutput ? "completed" : "failed";
		entry.output = payload.finalOutput ?? null;
		entry.end_time = payload.endTime ?? new Date().toISOString();
		if (payload.triggeringWorkflowInstanceId) {
			entry.triggering_workflow_instance_id =
				payload.triggeringWorkflowInstanceId;
		}
		await stateManager.saveState(state);

		console.log(
			`[finalizeWorkflow] instance=${payload.instanceId} status=${entry.status}`,
		);
	};
}

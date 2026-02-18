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
				payload.task ?? "Recovered workflow state",
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

		// Safety check: detect any assistant messages with tool_calls that lack
		// corresponding tool results (could happen if repair didn't cover all cases)
		for (let i = 0; i < entry.messages.length; i++) {
			const msg = entry.messages[i];
			if (msg.role === "assistant" && msg.tool_calls?.length) {
				const expectedIds = new Set(msg.tool_calls.map((tc: any) => tc.id));
				// Find tool results that follow this assistant message
				for (let j = i + 1; j < entry.messages.length; j++) {
					if (
						entry.messages[j].role === "tool" &&
						entry.messages[j].tool_call_id
					) {
						expectedIds.delete(entry.messages[j].tool_call_id!);
					}
					if (entry.messages[j].role === "assistant") break; // next turn
				}
				if (expectedIds.size > 0) {
					console.warn(
						`[callLlm] WARNING: assistant message at index ${i} has ${expectedIds.size} unmatched tool_call_ids: [${[...expectedIds].join(",")}]`,
					);
					// Remove the broken assistant message and all following messages
					// from this point to allow a clean retry
					console.warn(
						`[callLlm] Truncating ${entry.messages.length - i} messages from index ${i} to repair conversation`,
					);
					entry.messages.length = i;
					if (i > 0) entry.last_message = entry.messages[i - 1];
					await stateManager.saveState(state);
					break;
				}
			}
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
		const result = await callLlmAdapter(
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

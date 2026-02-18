/**
 * Dapr durable workflow — the agent loop.
 *
 * Direct port of Python `agent_workflow` generator at durable.py:237-455.
 * The Dapr Workflow runtime replays this generator on recovery; all
 * non-deterministic work happens inside activities.
 */

import type { WorkflowContext } from "@dapr/dapr";
import type { TriggerAction } from "../types/trigger.js";
import type { LlmCallResult } from "../llm/ai-sdk-adapter.js";
import type { ToolCall } from "../types/tool.js";
import type {
	LoopStepRecord,
	LoopStopCondition,
} from "../types/loop-policy.js";
import type {
	RecordInitialEntryPayload,
	CallLlmPayload,
	RunToolPayload,
	SaveToolResultsPayload,
	FinalizeWorkflowPayload,
} from "./activities.js";
import {
	computeUsageTotals,
	evaluateStopConditions,
	normalizeLoopPolicy,
	prepareLoopStep,
	usageFromUnknown,
} from "./loop-policy.js";

/** Return type from the agent workflow, including accumulated tool history. */
export interface AgentWorkflowResult {
	role: "assistant";
	content: string | null;
	/** Final message's tool_calls (usually empty — final turn is text). */
	tool_calls?: ToolCall[];
	/** Static tool calls not executed (approval / declaration-only termination). */
	static_tool_calls?: ToolCall[];
	/** All tool calls accumulated across every turn. */
	all_tool_calls: Array<{
		tool_name: string;
		tool_args: Record<string, unknown>;
		execution_result: unknown;
	}>;
	/** Final text answer extracted for convenience. */
	final_answer: string;
	/** Stop reason when loop termination is policy-driven or synthetic. */
	stop_reason?: string;
	/** Matched stop condition definition (if any). */
	stop_condition?: LoopStopCondition;
	/** Approval metadata when tool approval stopped execution. */
	requires_approval?: {
		toolNames: string[];
		toolCalls: ToolCall[];
	};
	usage_totals?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
}

/** Type for the bound activity functions passed from DurableAgent. */
export interface AgentActivities {
	recordInitialEntry: (
		ctx: any,
		payload: RecordInitialEntryPayload,
	) => Promise<void>;
	callLlm: (ctx: any, payload: CallLlmPayload) => Promise<LlmCallResult>;
	runTool: (
		ctx: any,
		payload: RunToolPayload,
	) => Promise<{
		role: string;
		content: string;
		tool_call_id: string;
		name: string;
	}>;
	saveToolResults: (ctx: any, payload: SaveToolResultsPayload) => Promise<void>;
	finalizeWorkflow: (
		ctx: any,
		payload: FinalizeWorkflowPayload,
	) => Promise<void>;
}

function parseToolArgs(toolCall: ToolCall): Record<string, unknown> {
	try {
		const parsed = JSON.parse(toolCall.function.arguments);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function extractDoneToolAnswer(input: {
	toolCalls: ToolCall[];
	doneToolName?: string;
	responseField?: string;
}): string | undefined {
	if (!input.doneToolName) return undefined;
	const match = input.toolCalls.find(
		(toolCall) => toolCall.function.name === input.doneToolName,
	);
	if (!match) return undefined;
	const args = parseToolArgs(match);
	const value = input.responseField ? args[input.responseField] : undefined;
	if (typeof value === "string" && value.trim()) {
		return value.trim();
	}
	return undefined;
}

function buildCelBindings(input: {
	task: string;
	instanceId: string;
	stepNumber: number;
	effectiveMaxIterations: number;
	steps: LoopStepRecord[];
	currentStep?: LoopStepRecord;
	approvalRequiredTools: string[];
}): Record<string, unknown> {
	const totals = computeUsageTotals(input.steps);
	return {
		workflow: {
			instance_id: input.instanceId,
			input_as_text: input.task,
			max_iterations: input.effectiveMaxIterations,
		},
		state: {
			stepCount: input.steps.length,
			totalUsage: totals,
			lastStep:
				input.steps.length > 0 ? input.steps[input.steps.length - 1] : null,
			approvalRequiredTools: input.approvalRequiredTools,
		},
		input:
			input.currentStep ??
			({
				stepNumber: input.stepNumber,
				assistantText: null,
				toolCalls: [],
				usage: undefined,
			} satisfies LoopStepRecord),
	};
}

/**
 * Create the agent workflow generator function.
 *
 * Uses closure over bound activities to access agent state.
 * Mirrors Python agent_workflow at durable.py:237-455.
 */
export function createAgentWorkflow(
	activities: AgentActivities,
	maxIterations: number,
) {
	return async function* agentWorkflow(
		ctx: WorkflowContext,
		input: TriggerAction,
	): AsyncGenerator<unknown, unknown, any> {
		const instanceId = ctx.getWorkflowInstanceId();
		const task = input.task ?? "Triggered without input.";
		// Per-request override, fall back to closure default
		const effectiveMaxIterations = input.maxIterations ?? maxIterations;
		const loopPolicy = normalizeLoopPolicy(input.loopPolicy);

		// Extract metadata from trigger
		const metadata = input._message_metadata ?? {};
		const triggeringWorkflowInstanceId =
			input.workflow_instance_id ??
			(metadata.triggering_workflow_instance_id as string | undefined);
		const source = (metadata.source as string) ?? "direct";
		const traceContext = input._otel_span_context;

		// Step 1 — bootstrap state entry
		yield ctx.callActivity(activities.recordInitialEntry, {
			instanceId,
			inputValue: task,
			source,
			triggeringWorkflowInstanceId,
			startTime: ctx.getCurrentUtcDateTime().toISOString(),
			traceContext,
		} satisfies RecordInitialEntryPayload);

		// Step 2 — ReAct-style agent loop
		let finalMessage: LlmCallResult | undefined;
		let finalStopReason: string | undefined;
		let finalStopCondition: LoopStopCondition | undefined;
		let staticToolCalls: ToolCall[] | undefined;
		let approvalRequired:
			| {
					toolNames: string[];
					toolCalls: ToolCall[];
			  }
			| undefined;
		let turn = 0;
		const stepHistory: LoopStepRecord[] = [];
		const executableByToolName = new Map<string, boolean>();

		// Accumulate all tool calls across every turn
		const allToolCalls: AgentWorkflowResult["all_tool_calls"] = [];

		// Track previous turn's tool results for crash recovery repair.
		// These are durable (stored in Dapr's event log as activity outputs).
		let previousToolResults:
			| Array<{
					role: string;
					content: string;
					tool_call_id: string;
					name: string;
			  }>
			| undefined;

		try {
			for (turn = 1; turn <= effectiveMaxIterations; turn++) {
				const preStepBindings = buildCelBindings({
					task,
					instanceId,
					stepNumber: turn,
					effectiveMaxIterations,
					steps: stepHistory,
					approvalRequiredTools: [...loopPolicy.approvalRequiredTools],
				});
				const preparedStep = prepareLoopStep(loopPolicy, turn, preStepBindings);
				const assistantResponse: LlmCallResult = yield ctx.callActivity(
					activities.callLlm,
					{
						instanceId,
						// Only pass the user task on the first turn
						task: turn === 1 ? task : undefined,
						// Pass previous tool results so callLlm can repair state after crashes
						previousToolResults,
						modelSpec: preparedStep.modelSpec,
						activeTools: preparedStep.activeTools,
						toolChoice: preparedStep.toolChoice,
						trimMessagesTo: preparedStep.trimMessagesTo,
						truncateToolResultChars: preparedStep.truncateToolResultChars,
						appendInstructions: preparedStep.appendInstructions,
						declarationOnlyTools: preparedStep.declarationOnlyTools,
						approvalRequiredTools: [...loopPolicy.approvalRequiredTools],
					} satisfies CallLlmPayload,
				);
				// Clear after passing — only needed for the first callLlm after tool execution
				previousToolResults = undefined;

				for (const declared of assistantResponse.declared_tools ?? []) {
					executableByToolName.set(declared.name, declared.executable);
				}

				const toolCalls = assistantResponse.tool_calls ?? [];
				const currentStep: LoopStepRecord = {
					stepNumber: turn,
					assistantText: assistantResponse.content ?? null,
					toolCalls,
					usage: usageFromUnknown(assistantResponse.usage),
				};

				if (toolCalls.length > 0) {
					const approvalCalls = toolCalls.filter((toolCall) =>
						loopPolicy.approvalRequiredTools.has(
							toolCall.function.name.trim().toLowerCase(),
						),
					);
					if (approvalCalls.length > 0) {
						stepHistory.push(currentStep);
						staticToolCalls = toolCalls;
						approvalRequired = {
							toolNames: [
								...new Set(
									approvalCalls.map((toolCall) => toolCall.function.name),
								),
							],
							toolCalls: approvalCalls,
						};
						finalStopReason = "tool_call_needs_approval";
						finalMessage = {
							role: "assistant",
							content:
								assistantResponse.content ??
								`Approval required for tool call(s): ${approvalRequired.toolNames.join(", ")}`,
							tool_calls: toolCalls,
						};
						break;
					}

					const nonExecutableCalls = toolCalls.filter(
						(toolCall) =>
							executableByToolName.get(toolCall.function.name) !== true,
					);
					if (nonExecutableCalls.length > 0) {
						stepHistory.push(currentStep);
						staticToolCalls = toolCalls;
						finalStopReason = "tool_without_execute";
						const doneToolName =
							loopPolicy.declarationOnlyTools.length > 0
								? loopPolicy.declarationOnlyTools[0]?.name
								: undefined;
						const doneToolAnswer = extractDoneToolAnswer({
							toolCalls: nonExecutableCalls,
							doneToolName,
							responseField: loopPolicy.doneToolResponseField,
						});
						finalMessage = {
							role: "assistant",
							content:
								doneToolAnswer ??
								assistantResponse.content ??
								"Stopped because a declaration-only tool was called.",
							tool_calls: toolCalls,
						};
						break;
					}

					// Parallel tool execution — each tool call is a separate activity
					const tasks = toolCalls.map((tc, idx) =>
						ctx.callActivity(activities.runTool, {
							toolCall: tc,
							instanceId,
							order: idx,
						} satisfies RunToolPayload),
					);
					const toolResults: Array<{
						role: string;
						content: string;
						tool_call_id: string;
						name: string;
					}> = yield ctx.whenAll(tasks);

					// Accumulate tool calls with their results for the workflow output
					for (let j = 0; j < toolCalls.length; j++) {
						const tc = toolCalls[j];
						const tr = toolResults[j];
						const parsedArgs = parseToolArgs(tc);
						let parsedResult: unknown;
						try {
							parsedResult = JSON.parse(tr?.content ?? "null");
						} catch {
							parsedResult = tr?.content ?? null;
						}

						allToolCalls.push({
							tool_name: tc.function.name,
							tool_args: parsedArgs,
							execution_result: parsedResult,
						});
					}

					// Persist all tool results
					yield ctx.callActivity(activities.saveToolResults, {
						toolResults,
						instanceId,
					} satisfies SaveToolResultsPayload);

					// Carry tool results forward for crash recovery repair.
					// If the pod crashes between saveToolResults and the next callLlm,
					// the generator will replay with these cached results and pass them
					// to callLlm to repair the conversation state in Redis.
					previousToolResults = toolResults;
					stepHistory.push(currentStep);
					const stopEvaluation = evaluateStopConditions({
						policy: loopPolicy,
						currentStep,
						allSteps: stepHistory,
						executableByToolName,
						celBindings: buildCelBindings({
							task,
							instanceId,
							stepNumber: turn,
							effectiveMaxIterations,
							steps: stepHistory,
							currentStep,
							approvalRequiredTools: [...loopPolicy.approvalRequiredTools],
						}),
					});
					if (stopEvaluation.shouldStop) {
						finalStopReason = stopEvaluation.reason;
						finalStopCondition = stopEvaluation.condition;
						finalMessage = {
							role: "assistant",
							content:
								assistantResponse.content ?? "Stopped due to loop policy.",
							tool_calls: assistantResponse.tool_calls,
						};
						break;
					}

					// Continue to next LLM turn
					continue;
				}

				stepHistory.push(currentStep);
				// No tool calls -> this is the final answer
				finalMessage = assistantResponse;
				break;
			}

			// If we exhausted all turns without a final answer
			if (!finalMessage) {
				finalMessage = {
					role: "assistant",
					content:
						"I reached the maximum number of reasoning steps before I could finish. " +
						"Please rephrase or provide more detail so I can try again.",
				};
			}
		} catch (err) {
			console.error(`[agentWorkflow] Error:`, err);
			finalMessage = {
				role: "assistant",
				content: `Error: ${String(err)}`,
			};
			finalStopReason = "workflow_error";
		}

		// Step 3 — finalize
		yield ctx.callActivity(activities.finalizeWorkflow, {
			instanceId,
			finalOutput: finalMessage.content ?? "",
			endTime: ctx.getCurrentUtcDateTime().toISOString(),
			triggeringWorkflowInstanceId,
		} satisfies FinalizeWorkflowPayload);

		// Return full result including accumulated tool history
		const usageTotals = computeUsageTotals(stepHistory);
		const result: AgentWorkflowResult = {
			role: finalMessage.role,
			content: finalMessage.content,
			tool_calls: finalMessage.tool_calls,
			...(staticToolCalls ? { static_tool_calls: staticToolCalls } : {}),
			all_tool_calls: allToolCalls,
			final_answer: finalMessage.content ?? "",
			...(finalStopReason ? { stop_reason: finalStopReason } : {}),
			...(finalStopCondition ? { stop_condition: finalStopCondition } : {}),
			...(approvalRequired ? { requires_approval: approvalRequired } : {}),
			usage_totals: usageTotals,
		};
		return result;
	};
}

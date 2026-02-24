/**
 * DAG Executor — Dapr Workflow + Activities for dependency-aware plan execution.
 *
 * Executes a claude_task_graph_v1 plan as a Dapr workflow where each task is a
 * Dapr activity running Claude Code CLI headless. Dapr provides activity-level
 * progress tracking, checkpointing (crash recovery), and retry.
 */

import type {
	ClaudeTask,
	ClaudeTaskPlan,
	ClaudeTaskStatus,
	TaskExecutionResult,
} from "./claude-plan-schema.js";
import type { workspaceSessions as workspaceSessionsInstance } from "./workspace-sessions.js";
import type { planArtifacts as planArtifactsInstance } from "./plan-artifacts.js";

type WorkspaceSessionManager = typeof workspaceSessionsInstance;
type PlanArtifactStore = typeof planArtifactsInstance;

// ── Types ─────────────────────────────────────────────────────

export type TaskState = {
	status: ClaudeTaskStatus;
	retries: number;
	result?: TaskExecutionResult;
};

export type DagExecutorInput = {
	plan: ClaudeTaskPlan;
	artifactRef: string;
	workspaceRef: string;
	cwd: string;
	goal: string;
	model?: string;
	maxTaskRetries: number;
	taskTimeoutMs: number;
	overallTimeoutMs: number;
	executionId: string;
	workflowId: string;
	nodeId: string;
};

export type DagExecutorResult = {
	success: boolean;
	completedTasks: number;
	failedTasks: number;
	skippedTasks: number;
	totalTasks: number;
	taskResults: Record<string, TaskExecutionResult>;
	terminationReason: string;
};

export type ExecuteClaudeTaskInput = {
	task: ClaudeTask;
	goal: string;
	completedContext: Array<{ id: string; subject: string; output?: string }>;
	workspaceRef: string;
	cwd: string;
	model?: string;
	taskTimeoutMs: number;
};

export type ExecuteClaudeTaskOutput = {
	success: boolean;
	output: string;
	error?: string;
	durationMs: number;
	exitCode: number;
};

export type PersistDagStateInput = {
	artifactRef: string;
	plan: ClaudeTaskPlan;
	taskStates: Record<string, TaskState>;
};

// ── Pure Utility Functions (testable) ─────────────────────────

/**
 * Find tasks that are ready to execute: status=pending and all blockedBy are completed.
 */
export function computeReadyTasks(
	tasks: ClaudeTask[],
	taskStates: Record<string, TaskState>,
): ClaudeTask[] {
	return tasks.filter((task) => {
		const state = taskStates[task.id];
		if (!state || state.status !== "pending") return false;
		return task.blockedBy.every((depId) => {
			const depState = taskStates[depId];
			return depState?.status === "completed";
		});
	});
}

/**
 * Mark all downstream dependents of a failed task as "skipped".
 */
export function markDownstreamSkipped(
	failedTaskId: string,
	tasks: ClaudeTask[],
	taskStates: Record<string, TaskState>,
): void {
	const queue = [failedTaskId];
	const visited = new Set<string>();

	while (queue.length > 0) {
		const currentId = queue.shift()!;
		if (visited.has(currentId)) continue;
		visited.add(currentId);

		for (const task of tasks) {
			if (task.blockedBy.includes(currentId)) {
				const state = taskStates[task.id];
				if (
					state &&
					(state.status === "pending" || state.status === "in_progress")
				) {
					state.status = "skipped";
					state.result = {
						taskId: task.id,
						status: "skipped",
						output: `Skipped: upstream task "${currentId}" failed`,
						retryCount: 0,
					};
					queue.push(task.id);
				}
			}
		}
	}
}

/**
 * Check if we're deadlocked: no tasks are completed/in_progress/pending-ready,
 * but not all tasks are in a terminal state.
 */
export function isDeadlocked(
	tasks: ClaudeTask[],
	taskStates: Record<string, TaskState>,
): boolean {
	const hasReadyTasks = computeReadyTasks(tasks, taskStates).length > 0;
	if (hasReadyTasks) return false;

	const hasInProgress = Object.values(taskStates).some(
		(s) => s.status === "in_progress",
	);
	if (hasInProgress) return false;

	const allTerminal = Object.values(taskStates).every(
		(s) =>
			s.status === "completed" ||
			s.status === "failed" ||
			s.status === "skipped",
	);
	// If all terminal, we're not deadlocked — we're done (possibly with failures)
	return !allTerminal;
}

/**
 * Build the task-specific prompt for Claude Code CLI execution.
 */
export function buildTaskPrompt(
	task: ClaudeTask,
	goal: string,
	completedContext: Array<{ id: string; subject: string; output?: string }>,
): string {
	const parts: string[] = [];

	parts.push(`Overall goal: ${goal}`);
	parts.push("");

	if (completedContext.length > 0) {
		parts.push("Completed prerequisites:");
		for (const ctx of completedContext) {
			const outputSummary = ctx.output ? ` — ${ctx.output.slice(0, 500)}` : "";
			parts.push(`- [${ctx.id}] ${ctx.subject}${outputSummary}`);
		}
		parts.push("");
	}

	parts.push(`## Current Task: ${task.subject}`);
	parts.push(task.description);

	if (task.targetPaths.length > 0) {
		parts.push("");
		parts.push(`Target files: ${task.targetPaths.join(", ")}`);
	}

	if (task.acceptanceCriteria.length > 0) {
		parts.push("");
		parts.push("Acceptance criteria:");
		for (const criterion of task.acceptanceCriteria) {
			parts.push(`- ${criterion}`);
		}
	}

	parts.push("");
	parts.push("Execute this task completely. Make all necessary file changes.");

	return parts.join("\n");
}

function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Parse stream-json output from Claude CLI.
 * Scans for the last JSON object line containing a "result" or content.
 */
export function parseStreamJsonOutput(stdout: string): {
	success: boolean;
	output: string;
	error?: string;
} {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return { success: false, output: "", error: "Empty CLI output" };
	}

	const lines = trimmed.split("\n").filter(Boolean);

	// Scan backwards for stream-json result messages
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.startsWith("{")) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed && typeof parsed === "object") {
				// stream-json format: look for type=result
				if (parsed.type === "result") {
					const result = parsed.result ?? parsed;
					const output =
						typeof result === "string"
							? result
							: (result?.content ??
								result?.text ??
								result?.final_answer ??
								JSON.stringify(result));
					return { success: true, output: String(output) };
				}
				// Fallback: look for a final assistant message
				if (
					parsed.type === "assistant" &&
					typeof parsed.message?.content === "string"
				) {
					return { success: true, output: parsed.message.content };
				}
			}
		} catch {}
	}

	// If we found no structured result, treat the raw stdout as output
	// (Claude may have output plain text)
	const lastChunk = trimmed.slice(-4000);
	return {
		success: true,
		output: lastChunk,
	};
}

/**
 * Initialize task states from plan tasks.
 */
export function initTaskStates(tasks: ClaudeTask[]): Record<string, TaskState> {
	const states: Record<string, TaskState> = {};
	for (const task of tasks) {
		states[task.id] = { status: "pending", retries: 0 };
	}
	return states;
}

/**
 * Build summary counts from task states.
 */
export function summarizeTaskStates(taskStates: Record<string, TaskState>): {
	completed: number;
	failed: number;
	skipped: number;
	pending: number;
	inProgress: number;
} {
	let completed = 0;
	let failed = 0;
	let skipped = 0;
	let pending = 0;
	let inProgress = 0;
	for (const state of Object.values(taskStates)) {
		switch (state.status) {
			case "completed":
				completed++;
				break;
			case "failed":
				failed++;
				break;
			case "skipped":
				skipped++;
				break;
			case "pending":
				pending++;
				break;
			case "in_progress":
				inProgress++;
				break;
		}
	}
	return { completed, failed, skipped, pending, inProgress };
}

// ── Dapr Activity: Execute a single Claude Code CLI task ──────

type ExecuteClaudeTaskDeps = {
	workspaceSessions: WorkspaceSessionManager;
};

export function createExecuteClaudeTask(deps: ExecuteClaudeTaskDeps) {
	return async function executeClaudeTask(
		_ctx: unknown,
		input: ExecuteClaudeTaskInput,
	): Promise<ExecuteClaudeTaskOutput> {
		const {
			task,
			goal,
			completedContext,
			workspaceRef,
			cwd,
			model,
			taskTimeoutMs,
		} = input;

		const prompt = buildTaskPrompt(task, goal, completedContext);

		const args = [
			"-p",
			prompt,
			"--permission-mode",
			"bypassPermissions",
			"--output-format",
			"stream-json",
			"--verbose",
			"--no-session-persistence",
		];
		if (typeof model === "string" && model.trim().length > 0) {
			args.push("--model", model.trim());
		}

		const command = `claude ${args.map(shellEscape).join(" ")} </dev/null`;
		const startedAt = Date.now();

		// Forward API keys from the durable-agent process into the sandbox
		const env: Record<string, string> = {};
		if (cwd) env.CLAUDE_CWD = cwd;
		if (process.env.ANTHROPIC_API_KEY?.trim()) {
			env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY.trim();
		}
		if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
			env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN.trim();
		}

		try {
			const result = await deps.workspaceSessions.executeCommand({
				workspaceRef,
				command,
				timeoutMs: taskTimeoutMs,
				env: Object.keys(env).length > 0 ? env : undefined,
			});

			const durationMs = Date.now() - startedAt;

			if (!result.success) {
				return {
					success: false,
					output: result.stdout || "",
					error:
						result.stderr || `Claude CLI exited with code ${result.exitCode}`,
					durationMs,
					exitCode: result.exitCode,
				};
			}

			const parsed = parseStreamJsonOutput(result.stdout);
			return {
				success: parsed.success,
				output: parsed.output,
				error: parsed.error,
				durationMs,
				exitCode: result.exitCode,
			};
		} catch (err) {
			const durationMs = Date.now() - startedAt;
			return {
				success: false,
				output: "",
				error: err instanceof Error ? err.message : String(err),
				durationMs,
				exitCode: -1,
			};
		}
	};
}

// ── Dapr Activity: Persist DAG state to DB ────────────────────

type PersistDagStateDeps = {
	planArtifacts: PlanArtifactStore;
};

export function createPersistDagState(deps: PersistDagStateDeps) {
	return async function persistDagState(
		_ctx: unknown,
		input: PersistDagStateInput,
	): Promise<{ success: boolean }> {
		try {
			// Update plan tasks with current status
			const updatedPlan = {
				...input.plan,
				tasks: input.plan.tasks.map((task) => {
					const state = input.taskStates[task.id];
					return state
						? { ...task, status: state.status, blocked: false }
						: task;
				}),
			};

			await deps.planArtifacts.updatePlanJson(
				input.artifactRef,
				updatedPlan as unknown as Record<string, unknown>,
			);

			return { success: true };
		} catch (err) {
			console.warn(
				`[dag-executor] Failed to persist DAG state for ${input.artifactRef}:`,
				err,
			);
			return { success: true }; // Non-fatal — don't fail the workflow
		}
	};
}

// ── Dapr Workflow: DAG Executor ───────────────────────────────

type DagExecutorDeps = {
	workspaceSessions: WorkspaceSessionManager;
	planArtifacts: PlanArtifactStore;
};

/**
 * Create the DAG executor workflow generator function.
 *
 * This is designed to be registered as a Dapr workflow. The workflow loop:
 * 1. Find ready tasks (pending, all blockedBy completed)
 * 2. Execute each ready task as a Dapr activity
 * 3. Update task states based on results
 * 4. Persist state after each batch
 * 5. Repeat until all tasks are terminal or deadlocked
 */
export function createDagExecutorWorkflow(deps: DagExecutorDeps) {
	const executeClaudeTask = createExecuteClaudeTask({
		workspaceSessions: deps.workspaceSessions,
	});
	const persistDagState = createPersistDagState({
		planArtifacts: deps.planArtifacts,
	});

	return {
		name: "dagExecutorWorkflow",
		implementation: async function* dagExecutorWorkflow(
			ctx: any,
			input: DagExecutorInput,
		): AsyncGenerator<any, DagExecutorResult> {
			const { plan, artifactRef, workspaceRef, cwd, goal, model } = input;
			const maxTaskRetries = input.maxTaskRetries ?? 1;
			const tasks = plan.tasks;
			const taskStates = initTaskStates(tasks);
			const taskResults: Record<string, TaskExecutionResult> = {};

			let iteration = 0;
			const maxIterations = tasks.length * (maxTaskRetries + 2);

			while (iteration < maxIterations) {
				iteration++;

				const readyTasks = computeReadyTasks(tasks, taskStates);

				if (readyTasks.length === 0) {
					const summary = summarizeTaskStates(taskStates);
					if (summary.pending === 0 && summary.inProgress === 0) {
						// All tasks are in terminal states
						break;
					}
					if (isDeadlocked(tasks, taskStates)) {
						// Deadlock: some tasks pending but none can proceed
						for (const [id, state] of Object.entries(taskStates)) {
							if (state.status === "pending") {
								state.status = "skipped";
								state.result = {
									taskId: id,
									status: "skipped",
									output:
										"Skipped: deadlocked (blocked by failed/skipped upstream tasks)",
									retryCount: 0,
								};
								taskResults[id] = state.result;
							}
						}
						break;
					}
					break;
				}

				// Execute ready tasks sequentially (each is checkpointed by Dapr)
				for (const task of readyTasks) {
					taskStates[task.id].status = "in_progress";

					// Build context from completed predecessors
					const completedContext = task.blockedBy
						.filter((depId) => taskStates[depId]?.status === "completed")
						.map((depId) => {
							const depTask = tasks.find((t) => t.id === depId);
							const depResult = taskResults[depId];
							return {
								id: depId,
								subject: depTask?.subject ?? depId,
								output: depResult?.output,
							};
						});

					const activityInput: ExecuteClaudeTaskInput = {
						task,
						goal,
						completedContext,
						workspaceRef,
						cwd,
						model,
						taskTimeoutMs: input.taskTimeoutMs,
					};

					const result: ExecuteClaudeTaskOutput = yield ctx.callActivity(
						executeClaudeTask,
						activityInput,
					);

					const execResult: TaskExecutionResult = {
						taskId: task.id,
						status: result.success ? "completed" : "failed",
						durationMs: result.durationMs,
						output: result.output,
						error: result.error,
						exitCode: result.exitCode,
						retryCount: taskStates[task.id].retries,
					};

					if (result.success) {
						taskStates[task.id].status = "completed";
						taskStates[task.id].result = execResult;
						taskResults[task.id] = execResult;
					} else if (taskStates[task.id].retries < maxTaskRetries) {
						taskStates[task.id].status = "pending";
						taskStates[task.id].retries++;
					} else {
						taskStates[task.id].status = "failed";
						taskStates[task.id].result = execResult;
						taskResults[task.id] = execResult;
						markDownstreamSkipped(task.id, tasks, taskStates);
						// Capture skipped results
						for (const [id, state] of Object.entries(taskStates)) {
							if (
								state.status === "skipped" &&
								state.result &&
								!taskResults[id]
							) {
								taskResults[id] = state.result;
							}
						}
					}
				}

				// Persist state after each batch
				yield ctx.callActivity(persistDagState, {
					artifactRef,
					plan,
					taskStates,
				} satisfies PersistDagStateInput);
			}

			const summary = summarizeTaskStates(taskStates);
			const allCompleted = summary.completed === tasks.length;
			let terminationReason: string;
			if (allCompleted) {
				terminationReason = "all_tasks_completed";
			} else if (summary.failed > 0) {
				terminationReason = `${summary.failed} task(s) failed, ${summary.skipped} skipped`;
			} else if (iteration >= maxIterations) {
				terminationReason = "max_iterations_reached";
			} else {
				terminationReason = "deadlock_or_unresolvable";
			}

			return {
				success: allCompleted,
				completedTasks: summary.completed,
				failedTasks: summary.failed,
				skippedTasks: summary.skipped,
				totalTasks: tasks.length,
				taskResults,
				terminationReason,
			};
		},
	};
}

/**
 * Mastra Agent Definition — Workspace Tools
 *
 * Development assistant agent with workspace tools:
 * read_file, write_file, edit_file, list_files, delete, mkdir,
 * file_stat, execute_command (auto-injected by Mastra Workspace).
 */

import { Agent } from "@mastra/core/agent";
import { Workspace, LocalFilesystem } from "@mastra/core/workspace";
import { openai } from "@ai-sdk/openai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { eventBus } from "./event-bus";
import { sandbox, WORKSPACE_PATH } from "./sandbox-config";

const workspace = new Workspace({
	filesystem: new LocalFilesystem({ basePath: WORKSPACE_PATH }),
	sandbox,
});

let initialized = false;

export async function initAgent(): Promise<void> {
	if (initialized) return;
	await workspace.init();
	initialized = true;
	console.log(`[mastra-agent] Workspace initialized at ${WORKSPACE_PATH}`);
}

const mastraAgent = new Agent({
	id: "mastra-dev-agent",
	name: "mastra-dev-agent",
	instructions: `You are a development assistant with access to workspace tools.

Use workspace tools to help users with file operations and command execution:
- Read, write, and edit files in the workspace
- List directory contents and get file metadata
- Execute shell commands
- Create and delete files and directories

Be concise and direct. Use the appropriate tool for each task.`,
	model: openai("gpt-4o-mini"),
	workspace,
});

// ── Planning Schema & Agent ──────────────────────────────────

const PlanStepSchema = z.object({
	step: z.number().describe("Step number (1-based)"),
	action: z.string().describe("What to do (e.g., 'Read the config file')"),
	tool: z.string().describe("Which workspace tool to use (e.g., 'read_file', 'execute_command')"),
	reasoning: z.string().describe("Why this step is needed"),
});

const PlanSchema = z.object({
	goal: z.string().describe("One-sentence summary of the overall goal"),
	steps: z.array(PlanStepSchema).describe("Ordered list of steps to accomplish the goal"),
	estimated_tool_calls: z.number().describe("Expected number of tool calls"),
});

export type Plan = z.infer<typeof PlanSchema>;

const plannerAgent = new Agent({
	id: "mastra-planner",
	name: "mastra-planner",
	instructions: `You are a planning agent. Given a task, create a structured execution plan.

Available workspace tools:
- read_file: Read a file from the workspace
- write_file: Create or overwrite a file
- edit_file: Find and replace text in a file
- list_files: List directory contents
- execute_command: Run a shell command
- delete: Delete a file or directory
- mkdir: Create a directory
- file_stat: Get file metadata

Rules:
- Break the task into concrete, sequential steps
- Each step should map to exactly one tool call
- Order steps logically (read before edit, mkdir before write, etc.)
- Be specific about file paths and commands
- Keep plans concise — avoid unnecessary steps`,
	model: openai("gpt-4o-mini"),
	// No workspace = no tools. Forces pure reasoning.
});

export async function generatePlan(prompt: string): Promise<Plan> {
	const result = await plannerAgent.generate(
		`Create an execution plan for this task:\n\n${prompt}`,
		{
			structuredOutput: {
				schema: PlanSchema,
			},
		},
	);
	return (result as any).object;
}

// ── Tool Names ───────────────────────────────────────────────

export const TOOL_NAMES = [
	"mastra_workspace_read_file",
	"mastra_workspace_write_file",
	"mastra_workspace_edit_file",
	"mastra_workspace_list_files",
	"mastra_workspace_delete",
	"mastra_workspace_file_stat",
	"mastra_workspace_mkdir",
	"mastra_workspace_execute_command",
];

export type RunResult = {
	text: string;
	plan?: Plan;
	toolCalls: Array<{ name: string; args: any; result: any }>;
	usage: { promptTokens: number; completionTokens: number; totalTokens: number };
};

export type RunOptions = {
	skipPlanning?: boolean;
};

export async function runAgent(prompt: string, options?: RunOptions): Promise<RunResult> {
	await initAgent();

	const skipPlanning = options?.skipPlanning ?? false;
	const runId = nanoid();
	const toolCalls: RunResult["toolCalls"] = [];
	let totalPromptTokens = 0;
	let totalCompletionTokens = 0;
	let plan: Plan | undefined;

	eventBus.setState({
		status: "running",
		currentActivity: `Processing: "${prompt.slice(0, 60)}"`,
		runId,
		startedAt: new Date().toISOString(),
	});
	eventBus.emitEvent("agent_started", { prompt });

	try {
		// Phase 1: Planning (unless skipped)
		let executionPrompt = prompt;

		if (!skipPlanning) {
			eventBus.emitEvent("planning_started", { prompt });

			plan = await generatePlan(prompt);

			eventBus.emitEvent("planning_completed", {
				goal: plan.goal,
				stepCount: plan.steps.length,
				estimatedToolCalls: plan.estimated_tool_calls,
			});

			// Inject plan into execution prompt
			const planText = plan.steps
				.map((s) => `${s.step}. [${s.tool}] ${s.action} — ${s.reasoning}`)
				.join("\n");

			executionPrompt = `## Task\n${prompt}\n\n## Execution Plan\nFollow this plan step-by-step:\n${planText}\n\nExecute each step in order. If a step fails, note the error and continue with the next step where possible.`;
		}

		// Phase 2: Execution
		const result = await mastraAgent.generate(executionPrompt, {
			maxSteps: 10,
			onStepFinish: (step: any) => {
				if (step.toolCalls && step.toolCalls.length > 0) {
					for (const tc of step.toolCalls) {
						const callId = nanoid(8);
						// Force plain serialization — AI SDK tool call objects may use
						// getter properties or class instances that don't survive JSON.stringify
						const toolName = String(tc.toolName ?? "");
						const args = JSON.parse(JSON.stringify(tc.args ?? {}));
						const tcResult = JSON.parse(JSON.stringify(tc.result ?? null));
						eventBus.emitEvent(
							"tool_call",
							{ toolName, args },
							callId,
						);
						toolCalls.push({
							name: toolName,
							args,
							result: tcResult,
						});
						eventBus.emitEvent(
							"tool_result",
							{ toolName, result: tcResult },
							callId,
						);
					}
				}
				if (step.usage) {
					const promptTok = Number(step.usage.promptTokens) || 0;
					const completionTok = Number(step.usage.completionTokens) || 0;
					totalPromptTokens += promptTok;
					totalCompletionTokens += completionTok;
					eventBus.emitEvent("llm_end", {
						promptTokens: promptTok,
						completionTokens: completionTok,
					});
				}
			},
		});

		const totalTokens = totalPromptTokens + totalCompletionTokens;
		eventBus.setState({
			status: "idle",
			currentActivity: null,
			totalRuns: eventBus.getState().totalRuns + 1,
			totalTokens: eventBus.getState().totalTokens + totalTokens,
			lastError: null,
		});
		eventBus.emitEvent("agent_completed", {
			success: true,
			text: result.text?.slice(0, 200),
			toolCallCount: toolCalls.length,
			totalTokens,
		});

		return {
			text: result.text ?? "",
			plan,
			toolCalls,
			usage: {
				promptTokens: totalPromptTokens,
				completionTokens: totalCompletionTokens,
				totalTokens,
			},
		};
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		eventBus.setState({
			status: "error",
			currentActivity: null,
			lastError: errorMsg,
			totalRuns: eventBus.getState().totalRuns + 1,
		});
		eventBus.emitEvent("agent_completed", {
			success: false,
			error: errorMsg,
		});
		throw error;
	}
}

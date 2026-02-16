/**
 * Mastra Agent Definition — Workspace Tools
 *
 * Development assistant agent with workspace tools:
 * read_file, write_file, edit_file, list_files, delete, mkdir,
 * file_stat, execute_command (auto-injected by Mastra Workspace).
 */

import { Agent } from "@mastra/core/agent";
import { Workspace } from "@mastra/core/workspace";
import { openai } from "@ai-sdk/openai";
import { nanoid } from "nanoid";
import { z } from "zod";
import { eventBus } from "./event-bus";
import {
	sandbox,
	filesystem,
	executeCommandViaSandbox,
} from "./sandbox-config";

const workspace = new Workspace({
	filesystem,
	sandbox,
});

let initialized = false;

export async function initAgent(): Promise<void> {
	if (initialized) return;
	await workspace.init();
	initialized = true;
	console.log(`[mastra-agent] Workspace initialized (fs=${filesystem.name})`);
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
	model: openai(process.env.AI_MODEL ?? "gpt-5.2-codex"),
	workspace,
});

// ── Planning Schema & Agent ──────────────────────────────────

const PlanStepSchema = z.object({
	step: z.number().describe("Step number (1-based)"),
	action: z.string().describe("What to do (e.g., 'Read the config file')"),
	tool: z
		.string()
		.describe(
			"Which workspace tool to use (e.g., 'read_file', 'execute_command')",
		),
	reasoning: z.string().describe("Why this step is needed"),
});

const PlanSchema = z.object({
	goal: z.string().describe("One-sentence summary of the overall goal"),
	steps: z
		.array(PlanStepSchema)
		.describe("Ordered list of steps to accomplish the goal"),
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
	model: openai(process.env.AI_MODEL ?? "gpt-5.2-codex"),
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

export type FileChange = {
	path: string;
	operation: "created" | "modified" | "deleted";
	content?: string;
};

export type RunResult = {
	text: string;
	plan?: Plan;
	toolCalls: Array<{ name: string; args: any; result: any }>;
	fileChanges: FileChange[];
	patch?: string;
	usage: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
};

export type RunOptions = {
	skipPlanning?: boolean;
};

/**
 * Extract a plain-object copy of a tool call from Mastra step data.
 *
 * Mastra wraps AI SDK tool calls in an envelope:
 *   { type: "tool-call", runId, from, payload: { toolCallId, toolName, args } }
 * We unwrap from payload first, then fall back to direct properties.
 */
function extractToolCall(tc: any): {
	name: string;
	args: any;
	toolCallId: string;
} {
	const p = tc.payload ?? tc;
	const toolName = p.toolName ?? p.name ?? p.tool_name ?? "";
	const args = p.args ?? p.arguments ?? p.input ?? {};
	const toolCallId = p.toolCallId ?? p.id ?? "";

	try {
		return {
			name: String(toolName),
			args: JSON.parse(JSON.stringify(args)),
			toolCallId: String(toolCallId),
		};
	} catch {
		return { name: String(toolName), args: {}, toolCallId: String(toolCallId) };
	}
}

function extractFileChanges(toolCalls: RunResult["toolCalls"]): FileChange[] {
	const changes: FileChange[] = [];
	const seen = new Map<string, number>();

	for (const tc of toolCalls) {
		const name = tc.name;
		const args = tc.args ?? {};

		if (name.endsWith("write_file")) {
			const path = String(args.path ?? args.filePath ?? "");
			if (!path) continue;
			const change: FileChange = {
				path,
				operation: "created",
				content: args.content != null ? String(args.content) : undefined,
			};
			if (seen.has(path)) {
				changes[seen.get(path)!] = change;
			} else {
				seen.set(path, changes.length);
				changes.push(change);
			}
		} else if (name.endsWith("edit_file")) {
			const path = String(args.path ?? args.filePath ?? "");
			if (!path) continue;
			const change: FileChange = { path, operation: "modified" };
			if (seen.has(path)) {
				changes[seen.get(path)!] = change;
			} else {
				seen.set(path, changes.length);
				changes.push(change);
			}
		} else if (name.endsWith("delete")) {
			const path = String(args.path ?? args.filePath ?? "");
			if (!path) continue;
			if (seen.has(path)) {
				changes[seen.get(path)!] = { path, operation: "deleted" };
			} else {
				seen.set(path, changes.length);
				changes.push({ path, operation: "deleted" });
			}
		}
	}

	return changes;
}

// ── Snapshot-based workspace diff ────────────────────────────
// The sandbox pod may not have git, so we use a Python script
// (guaranteed in python-runtime-sandbox) to snapshot all file
// contents before/after the agent runs and compute a unified diff.

// ── Git-based workspace diff ─────────────────────────────────
// The node-sandbox image includes git. We snapshot the workspace
// as a git baseline before the agent runs, then `git diff` after
// to produce a proper unified patch.

/**
 * Snapshot the workspace as a git baseline commit.
 * Returns true if the baseline was created successfully.
 */
async function gitBaseline(): Promise<boolean> {
	try {
		const result = await executeCommandViaSandbox(
			"git init -q && git add -A && git commit -q -m baseline --allow-empty",
			{ timeout: 15_000 },
		);
		if (result.exitCode !== 0) {
			console.warn(`[agent] git baseline failed: ${result.stderr}`);
			return false;
		}
		return true;
	} catch (err) {
		console.warn(`[agent] git baseline error: ${err}`);
		return false;
	}
}

/**
 * Generate a unified diff of all workspace changes since the baseline commit.
 */
async function gitDiff(): Promise<string | undefined> {
	try {
		const result = await executeCommandViaSandbox(
			"git add -A && git diff --cached HEAD --no-color",
			{ timeout: 15_000 },
		);
		if (result.exitCode !== 0) {
			console.warn(`[agent] git diff failed: ${result.stderr}`);
			return undefined;
		}
		const patch = result.stdout.trim();
		return patch || undefined;
	} catch (err) {
		console.warn(`[agent] git diff error: ${err}`);
		return undefined;
	}
}

function extractToolResult(tr: any): any {
	const p = tr.payload ?? tr;
	const result = p.result ?? p.output ?? p.content ?? null;
	try {
		return JSON.parse(JSON.stringify(result));
	} catch {
		return String(result);
	}
}

function extractToolCallId(tr: any): string {
	const p = tr.payload ?? tr;
	return String(p.toolCallId ?? p.id ?? "");
}

export async function runAgent(
	prompt: string,
	options?: RunOptions,
): Promise<RunResult> {
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
		// Phase 0: Git baseline — snapshot workspace so we can diff after
		const hasBaseline = await gitBaseline();

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
				// Process tool calls (Mastra wraps in { type, payload: { toolName, args } })
				if (step.toolCalls && step.toolCalls.length > 0) {
					// Build a map of tool results by toolCallId for correlation
					const resultMap = new Map<string, any>();
					if (step.toolResults) {
						for (const tr of step.toolResults) {
							resultMap.set(extractToolCallId(tr), extractToolResult(tr));
						}
					}

					for (const tc of step.toolCalls) {
						const callId = nanoid(8);
						const extracted = extractToolCall(tc);
						const tcResult = resultMap.get(extracted.toolCallId) ?? null;

						console.log(
							`[agent] tool: ${extracted.name} args=${JSON.stringify(extracted.args).slice(0, 100)}`,
						);

						eventBus.emitEvent(
							"tool_call",
							{ toolName: extracted.name, args: extracted.args },
							callId,
						);
						toolCalls.push({
							name: extracted.name,
							args: extracted.args,
							result: tcResult,
						});
						eventBus.emitEvent(
							"tool_result",
							{ toolName: extracted.name, result: tcResult },
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

		const fileChanges = extractFileChanges(toolCalls);

		// Phase 3: Git diff — generate unified patch from actual filesystem state
		const patch = hasBaseline ? await gitDiff() : undefined;

		return {
			text: result.text ?? "",
			plan,
			toolCalls,
			fileChanges,
			patch,
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

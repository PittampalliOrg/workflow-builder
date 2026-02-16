/**
 * Durable Agent Service Entry Point
 *
 * Express HTTP server exposing the same API surface as mastra-agent-tanstack,
 * but backed by DurableAgent (Dapr Workflow-based durable ReAct loop).
 *
 * Routes:
 * - GET  /api/health           — Health check
 * - GET  /api/tools            — List available tools
 * - POST /api/tools/:toolId    — Direct tool execution (bypass agent)
 * - POST /api/run              — Fire-and-forget agent run
 * - POST /api/plan             — Synchronous planning
 * - POST /api/execute-plan     — Fire-and-forget plan execution
 * - GET  /api/dapr/subscribe   — Dapr subscription discovery
 * - POST /api/dapr/sub         — Inbound Dapr events
 */

import { interceptConsole, eventBus } from "./event-bus.js";
interceptConsole();

import express from "express";
import { DaprWorkflowClient } from "@dapr/dapr";
import { nanoid } from "nanoid";
import { openai } from "@ai-sdk/openai";
import { DurableAgent } from "../durable-agent.js";
import { workspaceTools, listTools, executeTool, TOOL_NAMES } from "./tools.js";
import { sandbox, filesystem } from "./sandbox-config.js";
import {
	publishCompletionEvent,
	startDaprPublisher,
	handleDaprSubscriptionEvent,
	getDaprSubscriptions,
} from "./completion-publisher.js";
import { generatePlan } from "./planner.js";
import type { Plan } from "./planner.js";
import { gitBaseline, gitDiff } from "./git-diff.js";
import type { DaprEvent } from "./types.js";

// ── Configuration ─────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8001", 10);
const HOST = process.env.HOST || "0.0.0.0";

// ── Agent Setup ───────────────────────────────────────────────

let agent: DurableAgent | null = null;
let workflowClient: DaprWorkflowClient | null = null;
let initialized = false;

async function initAgent(): Promise<void> {
	if (initialized) return;

	// Start sandbox
	await sandbox.start();

	// Create durable agent with workspace tools
	agent = new DurableAgent({
		name: "durable-dev-agent",
		role: "Development assistant",
		goal: "Help users with file operations, code editing, and command execution",
		instructions: `You are a development assistant with access to workspace tools.

Use workspace tools to help users with file operations and command execution:
- Read, write, and edit files in the workspace
- List directory contents and get file metadata
- Execute shell commands
- Create and delete files and directories

Be concise and direct. Use the appropriate tool for each task.`,
		model: openai.chat(process.env.AI_MODEL ?? "gpt-4o"),
		tools: workspaceTools,
		state: {
			storeName: process.env.STATE_STORE_NAME || "statestore",
		},
		execution: {
			maxIterations: parseInt(process.env.MAX_ITERATIONS || "10", 10),
		},
	});

	// Start the agent (registers workflows + starts runtime)
	await agent.start();

	// Create workflow client for scheduling
	workflowClient = new DaprWorkflowClient();

	initialized = true;
	console.log("[durable-agent] Agent initialized and workflow runtime started");
}

// ── File Change Extraction ────────────────────────────────────

type FileChange = {
	path: string;
	operation: "created" | "modified" | "deleted";
	content?: string;
};

function extractFileChanges(
	toolCalls: Array<{ name: string; args: any; result: any }>,
): FileChange[] {
	const changes: FileChange[] = [];
	const seen = new Map<string, number>();

	for (const tc of toolCalls) {
		const name = tc.name;
		const args = tc.args ?? {};

		if (name === "write_file" || name.endsWith("write_file")) {
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
		} else if (name === "edit_file" || name.endsWith("edit_file")) {
			const path = String(args.path ?? args.filePath ?? "");
			if (!path) continue;
			const change: FileChange = { path, operation: "modified" };
			if (seen.has(path)) {
				changes[seen.get(path)!] = change;
			} else {
				seen.set(path, changes.length);
				changes.push(change);
			}
		} else if (name === "delete_file" || name === "delete" || name.endsWith("delete")) {
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

// ── Wait for Dapr Workflow Completion ─────────────────────────

async function waitForWorkflowCompletion(
	instanceId: string,
	timeoutSeconds = 30 * 60,
): Promise<{
	success: boolean;
	result?: Record<string, unknown>;
	error?: string;
}> {
	console.log(`[durable-agent] Waiting for workflow completion: ${instanceId} (timeout=${timeoutSeconds}s)`);

	try {
		// Use Dapr SDK's built-in wait (more reliable than custom polling)
		const state = await workflowClient!.waitForWorkflowCompletion(
			instanceId,
			true, // fetchPayloads
			timeoutSeconds,
		);

		if (!state) {
			console.warn(`[durable-agent] Workflow state not found: ${instanceId}`);
			return { success: false, error: "Workflow state not found" };
		}

		// WorkflowRuntimeStatus enum: RUNNING=0, COMPLETED=1, FAILED=3, TERMINATED=5
		const statusNum = state.runtimeStatus;
		console.log(`[durable-agent] Workflow ${instanceId} finished with status: ${statusNum}`);

		if (statusNum === 1) {
			// COMPLETED
			let result: Record<string, unknown> = {};
			if (state.serializedOutput) {
				try {
					result = JSON.parse(state.serializedOutput);
				} catch {
					result = { raw: state.serializedOutput };
				}
			}
			return { success: true, result };
		}

		if (statusNum === 3 || statusNum === 5) {
			// FAILED or TERMINATED
			let error = "Workflow failed";
			if ((state as any).failureDetails?.message) {
				error = (state as any).failureDetails.message;
			}
			return { success: false, error };
		}

		return { success: false, error: `Unexpected status: ${statusNum}` };
	} catch (err) {
		console.error(`[durable-agent] waitForWorkflowCompletion error: ${err}`);
		return { success: false, error: String(err) };
	}
}

// ── Express Server ────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/api/health", (_req, res) => {
	const state = eventBus.getState();
	res.json({
		service: "durable-agent",
		agentStatus: state.status,
		agentTools: TOOL_NAMES,
		totalRuns: state.totalRuns,
		totalTokens: state.totalTokens,
		initialized,
	});
});

// List available tools
app.get("/api/tools", (_req, res) => {
	res.json({ success: true, tools: listTools() });
});

// Execute a workspace tool directly
app.post("/api/tools/:toolId", async (req, res) => {
	const toolId = decodeURIComponent(req.params.toolId);
	try {
		await initAgent();
		const args = (req.body?.args as Record<string, unknown>) ?? req.body ?? {};
		const result = await executeTool(toolId, args);
		res.json({ success: true, toolId, result });
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		console.error(`[durable-agent] Tool ${toolId} failed: ${errorMsg}`);
		res.status(400).json({ success: false, toolId, error: errorMsg });
	}
});

// Agent run endpoint (fire-and-forget)
app.post("/api/run", async (req, res) => {
	try {
		const prompt = req.body?.prompt as string;
		if (!prompt) {
			res.status(400).json({ success: false, error: "prompt is required" });
			return;
		}

		await initAgent();

		const parentExecutionId = (req.body?.parentExecutionId as string) ?? "";
		const nodeId = (req.body?.nodeId as string) ?? "";
		const agentWorkflowId = `durable-run-${nanoid(12)}`;

		// Set workflow context on eventBus
		eventBus.setWorkflowContext({
			workflowId: agentWorkflowId,
			nodeId,
			stepIndex: 0,
		});

		console.log(
			`[durable-agent] /api/run: agentWorkflowId=${agentWorkflowId} prompt="${prompt.slice(0, 80)}"`,
		);

		// Git baseline — snapshot workspace for diff
		const hasBaseline = await gitBaseline();

		// Schedule the durable agent workflow
		const instanceId = await workflowClient!.scheduleNewWorkflow(
			agent!.agentWorkflow,
			{ task: prompt },
		);

		console.log(
			`[durable-agent] Scheduled Dapr workflow: instance=${instanceId}`,
		);

		// Fire-and-forget: wait for completion in background, then publish
		(async () => {
			console.log(`[durable-agent] Background: starting completion wait for ${instanceId} (parent=${parentExecutionId})`);
			try {
				const completion = await waitForWorkflowCompletion(instanceId);

				// Generate git diff
				const patch = hasBaseline ? await gitDiff() : undefined;

				// Extract tool calls from result if available
				const toolCalls: Array<{ name: string; args: any; result: any }> = [];
				if (completion.result?.tool_calls && Array.isArray(completion.result.tool_calls)) {
					for (const tc of completion.result.tool_calls) {
						toolCalls.push({
							name: tc.tool_name || tc.name || "",
							args: tc.tool_args || tc.args || {},
							result: tc.execution_result || tc.result || null,
						});
					}
				}

				const fileChanges = extractFileChanges(toolCalls);

				// Extract text from the final message
				const text =
					(completion.result?.final_answer as string) ??
					(completion.result?.last_message as string) ??
					JSON.stringify(completion.result ?? {});

				await publishCompletionEvent({
					agentWorkflowId,
					parentExecutionId,
					success: completion.success,
					result: {
						text,
						toolCalls,
						fileChanges,
						patch,
						daprInstanceId: instanceId,
					},
					error: completion.error,
				});
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				console.error(`[durable-agent] Background run failed: ${errorMsg}`);
				await publishCompletionEvent({
					agentWorkflowId,
					parentExecutionId,
					success: false,
					error: errorMsg,
				});
			}
		})();

		// Return immediately
		res.json({
			success: true,
			workflow_id: agentWorkflowId,
			dapr_instance_id: instanceId,
		});
	} catch (err) {
		res.status(400).json({ success: false, error: String(err) });
	}
});

// Plan endpoint (synchronous)
app.post("/api/plan", async (req, res) => {
	try {
		const prompt = req.body?.prompt as string;
		if (!prompt) {
			res.status(400).json({ success: false, error: "prompt is required" });
			return;
		}

		await initAgent();

		const cwd = (req.body?.cwd as string) ?? "";

		eventBus.emitEvent("planning_started", { prompt });

		// Give planning agent directory context
		let contextPrefix = "";
		if (cwd) {
			try {
				const files = await executeTool("list_files", { path: cwd });
				contextPrefix = `Working directory: ${cwd}\nDirectory contents: ${JSON.stringify(files)}\n\n`;
			} catch {
				/* non-fatal */
			}
		}

		const plan = await generatePlan(contextPrefix + prompt);

		eventBus.emitEvent("planning_completed", {
			goal: plan.goal,
			stepCount: plan.steps.length,
			estimatedToolCalls: plan.estimated_tool_calls,
		});

		res.json({ success: true, plan });
	} catch (err) {
		res.status(500).json({ success: false, error: String(err) });
	}
});

// Execute plan endpoint (fire-and-forget)
app.post("/api/execute-plan", async (req, res) => {
	try {
		const plan = req.body?.plan as Plan | undefined;
		const cwd = (req.body?.cwd as string) ?? "";
		const prompt = (req.body?.prompt as string) ?? "";
		const parentExecutionId = (req.body?.parentExecutionId as string) ?? "";
		const agentWorkflowId = `durable-exec-${nanoid(12)}`;

		if (!plan || !plan.steps?.length) {
			res
				.status(400)
				.json({ success: false, error: "plan with steps is required" });
			return;
		}

		await initAgent();

		eventBus.setWorkflowContext({
			workflowId: agentWorkflowId,
			nodeId: (req.body?.nodeId as string) ?? "",
			stepIndex: 0,
		});

		// Build execution prompt with plan injected
		const planText = plan.steps
			.map(
				(s) => `${s.step}. [${s.tool}] ${s.action} — ${s.reasoning}`,
			)
			.join("\n");
		const cwdContext = cwd ? `Working directory: ${cwd}\n\n` : "";
		const executionPrompt = `${cwdContext}## Task\n${prompt || plan.goal}\n\n## Execution Plan\nFollow this plan step-by-step:\n${planText}\n\nExecute each step in order. If a step fails, note the error and continue.`;

		// Git baseline
		const hasBaseline = await gitBaseline();

		// Schedule workflow
		const instanceId = await workflowClient!.scheduleNewWorkflow(
			agent!.agentWorkflow,
			{ task: executionPrompt },
		);

		// Fire-and-forget
		(async () => {
			try {
				const completion = await waitForWorkflowCompletion(instanceId);
				const patch = hasBaseline ? await gitDiff() : undefined;

				const text =
					(completion.result?.final_answer as string) ??
					(completion.result?.last_message as string) ??
					JSON.stringify(completion.result ?? {});

				await publishCompletionEvent({
					agentWorkflowId,
					parentExecutionId,
					success: completion.success,
					result: { text, plan, patch, daprInstanceId: instanceId },
					error: completion.error,
				});
			} catch (err) {
				await publishCompletionEvent({
					agentWorkflowId,
					parentExecutionId,
					success: false,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		})();

		res.json({
			success: true,
			workflow_id: agentWorkflowId,
			dapr_instance_id: instanceId,
		});
	} catch (err) {
		res.status(400).json({ success: false, error: String(err) });
	}
});

// Dapr subscription discovery
app.get("/api/dapr/subscribe", (_req, res) => {
	res.json(getDaprSubscriptions());
});

// Dapr event delivery
app.post("/api/dapr/sub", (req, res) => {
	try {
		const body = req.body as Record<string, unknown>;
		handleDaprSubscriptionEvent({
			id: (body.id as string) ?? "",
			source: (body.source as string) ?? "",
			type: (body.type as string) ?? "",
			specversion: (body.specversion as string) ?? "1.0",
			datacontenttype:
				(body.datacontenttype as string) ?? "application/json",
			data: (body.data as Record<string, unknown>) ?? {},
		} as DaprEvent);
		res.json({ status: "SUCCESS" });
	} catch (err) {
		res.status(400).json({ error: String(err) });
	}
});

// ── Startup ───────────────────────────────────────────────────

eventBus.setState({ toolNames: TOOL_NAMES });
startDaprPublisher();

// Graceful shutdown
async function shutdown(signal: string) {
	console.log(`[durable-agent] Received ${signal}, shutting down...`);
	try {
		if (agent) await agent.stop();
		await sandbox.destroy();
	} catch (err) {
		console.error("[durable-agent] Shutdown error:", err);
	}
	process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.listen(PORT, HOST, () => {
	console.log(`[durable-agent] Server listening on http://${HOST}:${PORT}`);
	console.log(`[durable-agent]   POST /api/run          — start agent workflow`);
	console.log(`[durable-agent]   POST /api/plan         — generate plan`);
	console.log(`[durable-agent]   POST /api/execute-plan  — execute plan`);
	console.log(`[durable-agent]   POST /api/tools/:id    — direct tool execution`);
	console.log(`[durable-agent]   GET  /api/health       — health check`);
});

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

// Mastra adapters (all optional — graceful fallback if packages not installed)
import {
	registerBuiltinProviders,
	resolveModel,
	adaptMastraTools,
	type MastraToolLike,
} from "../mastra/index.js";
import { discoverMcpTools } from "../mastra/mcp-client-setup.js";
import { createMastraWorkspaceTools } from "../mastra/workspace-setup.js";
import { createProcessors, type ProcessorLike } from "../mastra/processor-adapter.js";
import { createRagTools } from "../mastra/rag-tools.js";
import { createVoiceTools, type VoiceProviderLike } from "../mastra/voice-tools.js";
import { runScorers, createScorers, type ScorerLike } from "../mastra/eval-scorer.js";

// ── Configuration ─────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8001", 10);
const HOST = process.env.HOST || "0.0.0.0";

// ── Agent Setup ───────────────────────────────────────────────

let agent: DurableAgent | null = null;
let workflowClient: DaprWorkflowClient | null = null;
let initialized = false;
let mcpDisconnect: (() => Promise<void>) | null = null;
let scorers: ScorerLike[] = [];

async function initAgent(): Promise<void> {
	if (initialized) return;

	// Register built-in model providers (openai)
	registerBuiltinProviders();

	// Start sandbox
	await sandbox.start();

	// Resolve model: prefer MASTRA_MODEL_SPEC, fallback to AI_MODEL env var
	const modelSpec = process.env.MASTRA_MODEL_SPEC;
	const model = modelSpec
		? resolveModel(modelSpec)
		: openai.chat(process.env.AI_MODEL ?? "gpt-4o");

	if (modelSpec) {
		console.log(`[durable-agent] Model resolved from MASTRA_MODEL_SPEC: ${modelSpec}`);
	}

	// Merge all tool sources into a single record
	const mergedTools: Record<string, import("../types/tool.js").DurableAgentTool> = {
		...workspaceTools,
	};

	// Mastra workspace tools (if MASTRA_WORKSPACE=true)
	if (process.env.MASTRA_WORKSPACE === "true") {
		const wsTools = await createMastraWorkspaceTools(filesystem, sandbox);
		Object.assign(mergedTools, wsTools);
	}

	// MCP tools (if MCP_SERVERS env var set)
	if (process.env.MCP_SERVERS) {
		const mcp = await discoverMcpTools();
		Object.assign(mergedTools, mcp.tools);
		mcpDisconnect = mcp.disconnect;
	}

	// RAG tools (if MASTRA_RAG_TOOLS env var set)
	if (process.env.MASTRA_RAG_TOOLS) {
		const ragTools = await createRagTools();
		Object.assign(mergedTools, ragTools);
	}

	// Processors (if MASTRA_PROCESSORS env var set)
	let processors: ProcessorLike[] = [];
	if (process.env.MASTRA_PROCESSORS) {
		processors = await createProcessors(process.env.MASTRA_PROCESSORS);
	}

	// Scorers (if MASTRA_SCORERS env var set) — run post-workflow
	if (process.env.MASTRA_SCORERS) {
		scorers = await createScorers(process.env.MASTRA_SCORERS);
	}

	console.log(
		`[durable-agent] Merged tools (${Object.keys(mergedTools).length}): ${Object.keys(mergedTools).join(", ")}`,
	);

	// Create durable agent with all tool sources and optional Mastra integrations
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
		model,
		tools: mergedTools,
		state: {
			storeName: process.env.STATE_STORE_NAME || "statestore",
		},
		execution: {
			maxIterations: parseInt(process.env.MAX_ITERATIONS || "50", 10),
		},
		mastra: {
			processors: processors.length > 0 ? processors : undefined,
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

type ToolCallRecord = { name: string; args: any; result: any };

type FileChange = {
	path: string;
	operation: "created" | "modified" | "deleted";
	content?: string;
};

/**
 * Extract tool calls from the workflow completion result.
 *
 * The agent workflow returns `all_tool_calls` (accumulated across all turns)
 * and `tool_calls` (from the final message only, usually empty).
 */
function extractToolCalls(result: Record<string, unknown> | undefined): ToolCallRecord[] {
	if (!result) return [];

	const toolCalls: ToolCallRecord[] = [];

	// Primary: use all_tool_calls accumulated across all turns
	const allTc = result.all_tool_calls;
	if (Array.isArray(allTc) && allTc.length > 0) {
		for (const tc of allTc) {
			toolCalls.push({
				name: (tc as any).tool_name || (tc as any).name || "",
				args: (tc as any).tool_args || (tc as any).args || {},
				result: (tc as any).execution_result || (tc as any).result || null,
			});
		}
		return toolCalls;
	}

	// Fallback: check tool_calls on the result (legacy / final message only)
	const legacyTc = result.tool_calls;
	if (Array.isArray(legacyTc)) {
		for (const tc of legacyTc) {
			toolCalls.push({
				name: (tc as any).tool_name || (tc as any).name || "",
				args: (tc as any).tool_args || (tc as any).args || {},
				result: (tc as any).execution_result || (tc as any).result || null,
			});
		}
	}

	return toolCalls;
}

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

		// Per-request maxTurns override
		const maxTurns = req.body?.maxTurns
			? parseInt(String(req.body.maxTurns), 10)
			: undefined;

		// Schedule the durable agent workflow
		const instanceId = await workflowClient!.scheduleNewWorkflow(
			agent!.agentWorkflow,
			{ task: prompt, ...(maxTurns ? { maxIterations: maxTurns } : {}) },
		);

		console.log(
			`[durable-agent] Scheduled Dapr workflow: instance=${instanceId} maxTurns=${maxTurns ?? "default"}`,
		);

		// Fire-and-forget: wait for completion in background, then publish
		(async () => {
			console.log(`[durable-agent] Background: starting completion wait for ${instanceId} (parent=${parentExecutionId})`);
			try {
				const completion = await waitForWorkflowCompletion(instanceId);

				// Generate git diff
				const patch = hasBaseline ? await gitDiff() : undefined;

				// Extract tool calls from all turns
				const toolCalls = extractToolCalls(completion.result);
				const fileChanges = extractFileChanges(toolCalls);

				// Extract text from the final message
				const text =
					(completion.result?.final_answer as string) ??
					(completion.result?.last_message as string) ??
					(completion.result?.content as string) ??
					JSON.stringify(completion.result ?? {});

				// Run post-workflow scorers (outside Dapr generator)
				let evalResults: unknown[] | undefined;
				if (scorers.length > 0 && completion.success) {
					evalResults = await runScorers(scorers, prompt, text, instanceId);
				}

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
						...(evalResults ? { evalResults } : {}),
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
		const executionPrompt = `${cwdContext}## Task\n${prompt || plan.goal}\n\n## Execution Plan\nFollow this plan step-by-step:\n${planText}\n\nIMPORTANT: You MUST execute ALL steps using tools. Do NOT stop after reading files — you must also write/edit files as specified in the plan. Complete every step before giving your final answer. If a step fails, note the error and continue with the next step.`;

		// Per-request maxTurns override
		const maxTurns = req.body?.maxTurns
			? parseInt(String(req.body.maxTurns), 10)
			: undefined;

		// Git baseline
		const hasBaseline = await gitBaseline();

		// Schedule workflow
		const instanceId = await workflowClient!.scheduleNewWorkflow(
			agent!.agentWorkflow,
			{ task: executionPrompt, ...(maxTurns ? { maxIterations: maxTurns } : {}) },
		);

		// Fire-and-forget
		(async () => {
			try {
				const completion = await waitForWorkflowCompletion(instanceId);
				const patch = hasBaseline ? await gitDiff() : undefined;

				// Extract tool calls from all turns
				const toolCalls = extractToolCalls(completion.result);
				const fileChanges = extractFileChanges(toolCalls);

				const text =
					(completion.result?.final_answer as string) ??
					(completion.result?.last_message as string) ??
					(completion.result?.content as string) ??
					JSON.stringify(completion.result ?? {});

				await publishCompletionEvent({
					agentWorkflowId,
					parentExecutionId,
					success: completion.success,
					result: { text, toolCalls, fileChanges, patch, plan, daprInstanceId: instanceId },
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
		if (mcpDisconnect) await mcpDisconnect();
		if (agent) await agent.stop();
		await sandbox.destroy();
	} catch (err) {
		console.error("[durable-agent] Shutdown error:", err);
	}
	process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

app.listen(PORT, HOST, async () => {
	console.log(`[durable-agent] Server listening on http://${HOST}:${PORT}`);
	console.log(`[durable-agent]   POST /api/run          — start agent workflow`);
	console.log(`[durable-agent]   POST /api/plan         — generate plan`);
	console.log(`[durable-agent]   POST /api/execute-plan  — execute plan`);
	console.log(`[durable-agent]   POST /api/tools/:id    — direct tool execution`);
	console.log(`[durable-agent]   GET  /api/health       — health check`);

	// Initialize agent eagerly at startup so the Dapr workflow runtime starts
	// immediately. This is required for crash recovery: pending workflows in
	// the Dapr event log need the runtime to be running to replay.
	try {
		await initAgent();
		console.log("[durable-agent] Agent initialized at startup (workflow runtime ready for replay)");
	} catch (err) {
		console.error("[durable-agent] Startup initialization failed (will retry on first request):", err);
	}
});

/**
 * Durable Agent Service Entry Point
 *
 * Express HTTP server exposing the same API surface as mastra-agent-tanstack,
 * but backed by DurableAgent (Dapr Workflow-based durable ReAct loop).
 *
 * Routes:
 * - GET  /api/health           — Health check
 * - GET  /api/ready            — Readiness check (initialized runtime)
 * - GET  /api/tools            — List available tools
 * - POST /api/tools/:toolId    — Direct tool execution (bypass agent)
 * - POST /api/workspaces/profile — Create/get execution-scoped workspace
 * - POST /api/workspaces/clone   — Clone Git repo into workspace session
 * - POST /api/workspaces/command — Execute command in workspace
 * - POST /api/workspaces/file    — Execute file operation in workspace
 * - POST /api/workspaces/cleanup — Cleanup workspace session(s)
 * - GET  /api/workspaces/changes/:changeSetId — Fetch stored patch artifact
 * - GET  /api/workspaces/executions/:executionId/changes — List change artifacts
 * - GET  /api/workspaces/executions/:executionId/patch — Export combined patch
 * - GET  /api/workspaces/executions/:executionId/files/snapshot?path=<file> — Fetch aggregated file snapshot
 * - POST /api/run              — Fire-and-forget agent run
 * - POST /api/plan             — Synchronous planning
 * - POST /api/execute-plan     — Fire-and-forget plan execution
 * - GET  /api/dapr/subscribe   — Dapr subscription discovery
 * - POST /api/dapr/sub         — Inbound Dapr events
 */

import { initOtel } from "../observability/otel-setup.js";
initOtel("durable-agent");

import { interceptConsole, eventBus } from "./event-bus.js";
interceptConsole();

import express from "express";
import { DaprWorkflowClient } from "@dapr/dapr";
import { nanoid } from "nanoid";
import { openai } from "@ai-sdk/openai";
import { DurableAgent } from "../durable-agent.js";
import { workspaceTools, listTools, executeTool, TOOL_NAMES } from "./tools.js";
import { sandbox, filesystem } from "./sandbox-config.js";
import { workspaceSessions } from "./workspace-sessions.js";
import {
	publishCompletionEvent,
	startDaprPublisher,
	handleDaprSubscriptionEvent,
	getDaprSubscriptions,
} from "./completion-publisher.js";
import {
	PlanGenerationError,
	generatePlanFromMarkdown,
	validatePlanForExecution,
} from "./planner.js";
import type { Plan } from "./planner.js";
import { planArtifacts } from "./plan-artifacts.js";
import { workflowRunTracker } from "./run-tracker.js";
import type { DaprEvent } from "./types.js";
import {
	buildPlanModePrompt,
	buildPlanRepairPrompt,
} from "./plan-mode-prompt.js";
import {
	extractProposedPlanText,
	stripProposedPlanBlocks,
} from "./proposed-plan-parser.js";
import {
	normalizeModelSpecForEnvironment,
	normalizeOpenAiChatModel,
} from "./model-normalization.js";

// Mastra adapters (all optional — graceful fallback if packages not installed)
import {
	registerBuiltinProviders,
	resolveModel,
	adaptMastraTools,
	type MastraToolLike,
} from "../mastra/index.js";
import type { LoopPolicy } from "../types/loop-policy.js";
import { discoverMcpTools } from "../mastra/mcp-client-setup.js";
import { createMastraWorkspaceTools } from "../mastra/workspace-setup.js";
import {
	createProcessors,
	type ProcessorLike,
} from "../mastra/processor-adapter.js";
import { createRagTools } from "../mastra/rag-tools.js";
import {
	createVoiceTools,
	type VoiceProviderLike,
} from "../mastra/voice-tools.js";
import {
	runScorers,
	createScorers,
	type ScorerLike,
} from "../mastra/eval-scorer.js";

// ── Configuration ─────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "8001", 10);
const HOST = process.env.HOST || "0.0.0.0";
const RUN_RECONCILE_INTERVAL_MS = parseInt(
	process.env.DURABLE_RUN_RECONCILE_INTERVAL_MS || "15000",
	10,
);
const PLAN_REPAIR_ATTEMPTS = Math.max(
	0,
	parseInt(process.env.DURABLE_PLAN_REPAIR_ATTEMPTS || "2", 10),
);
const PLAN_REPAIR_MAX_TURNS = Math.max(
	1,
	parseInt(process.env.DURABLE_PLAN_REPAIR_MAX_TURNS || "8", 10),
);
const PLAN_TIMEOUT_SECONDS = Math.max(
	60,
	parseInt(process.env.DURABLE_PLAN_TIMEOUT_SECONDS || "600", 10),
);
const STARTUP_INIT_REQUIRED = ["1", "true", "yes", "on"].includes(
	String(process.env.DURABLE_REQUIRE_STARTUP_INIT || "")
		.trim()
		.toLowerCase(),
);
const STARTUP_INIT_RETRY_MS = Math.max(
	5_000,
	parseInt(process.env.DURABLE_STARTUP_INIT_RETRY_MS || "30000", 10),
);

// ── Agent Config Types ────────────────────────────────────────

/**
 * Per-request agent configuration passed from the BFF.
 * When present in /api/run body, overrides the default agent.
 */
type AgentConfigPayload = {
	name: string;
	instructions: string;
	modelSpec: string; // "provider/model" format, e.g., "openai/gpt-4o"
	maxTurns?: number;
	timeoutMinutes?: number;
	tools?: string[]; // List of tool names to enable (subset of workspace tools)
};

// ── Agent Setup ───────────────────────────────────────────────

let agent: DurableAgent | null = null;
let workflowClient: DaprWorkflowClient | null = null;
let initialized = false;
let initializingPromise: Promise<void> | null = null;
let mcpDisconnect: (() => Promise<void>) | null = null;
let scorers: ScorerLike[] = [];
let reconcileLoopStarted = false;
let reconcilingRuns = false;
let startupInitRetryTimer: NodeJS.Timeout | null = null;

// Merged tools from all sources (populated in initAgent)
let allMergedTools: Record<
	string,
	import("../types/tool.js").DurableAgentTool
> = {};

// LRU cache for per-request agent instances (keyed by config hash)
const agentCache = new Map<string, { agent: DurableAgent; lastUsed: number }>();
const AGENT_CACHE_MAX = 10;
const AGENT_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function agentConfigHash(config: AgentConfigPayload): string {
	const key = JSON.stringify({
		n: config.name,
		i: config.instructions.slice(0, 200),
		m: config.modelSpec,
		t: config.tools?.sort(),
	});
	// Simple string hash
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
	}
	return `agent-${hash.toString(36)}`;
}

function resolveNormalizedModel(modelSpecRaw: string) {
	return resolveModel(normalizeModelSpecForEnvironment(modelSpecRaw));
}

function evictStaleAgents(): void {
	const now = Date.now();
	for (const [key, entry] of agentCache) {
		if (now - entry.lastUsed > AGENT_CACHE_TTL_MS) {
			agentCache.delete(key);
		}
	}
	// If still over max, remove oldest
	while (agentCache.size > AGENT_CACHE_MAX) {
		let oldestKey = "";
		let oldestTime = Infinity;
		for (const [key, entry] of agentCache) {
			if (entry.lastUsed < oldestTime) {
				oldestTime = entry.lastUsed;
				oldestKey = key;
			}
		}
		if (oldestKey) agentCache.delete(oldestKey);
	}
}

/**
 * Create a DurableAgent from per-request config, or return cached instance.
 */
async function getOrCreateConfiguredAgent(
	config: AgentConfigPayload,
): Promise<DurableAgent> {
	const hash = agentConfigHash(config);
	const cached = agentCache.get(hash);
	if (cached) {
		cached.lastUsed = Date.now();
		return cached.agent;
	}

	evictStaleAgents();

	// Resolve model
	const effectiveModelSpec = normalizeModelSpecForEnvironment(config.modelSpec);
	const model = resolveModel(effectiveModelSpec);

	// Filter tools if specified
	let tools = allMergedTools;
	if (config.tools && config.tools.length > 0) {
		const allowed = new Set(config.tools);
		tools = {};
		for (const [name, tool] of Object.entries(allMergedTools)) {
			if (allowed.has(name)) {
				tools[name] = tool;
			}
		}
	}

	console.log(
		`[durable-agent] Creating configured agent: name=${config.name} model=${effectiveModelSpec} tools=${Object.keys(tools).length}`,
	);

	const configuredAgent = new DurableAgent({
		name: config.name,
		role: "Configured agent",
		goal: "Execute task according to custom instructions",
		instructions: config.instructions,
		model,
		modelResolver: resolveNormalizedModel,
		tools,
		state: {
			storeName: process.env.STATE_STORE_NAME || "statestore",
		},
		execution: {
			maxIterations: config.maxTurns ?? 50,
		},
	});

	await configuredAgent.start();

	agentCache.set(hash, { agent: configuredAgent, lastUsed: Date.now() });
	return configuredAgent;
}

async function initAgent(): Promise<void> {
	if (initialized) return;
	if (initializingPromise) {
		await initializingPromise;
		return;
	}

	initializingPromise = (async () => {
		try {
			// Fail fast at startup if durable change persistence is misconfigured.
			await workspaceSessions.ensureChangeArtifactPersistence();

			// Register built-in model providers (openai)
			registerBuiltinProviders();

			// Start sandbox
			await sandbox.start();

			// Resolve model: prefer MASTRA_MODEL_SPEC, fallback to AI_MODEL env var
			const modelSpecRaw = process.env.MASTRA_MODEL_SPEC;
			const modelSpec = modelSpecRaw
				? normalizeModelSpecForEnvironment(modelSpecRaw)
				: undefined;
			const model = modelSpec
				? resolveModel(modelSpec)
				: openai.chat(
						normalizeOpenAiChatModel(process.env.AI_MODEL || "", "AI_MODEL"),
					);

			if (modelSpecRaw) {
				console.log(
					`[durable-agent] Model resolved from MASTRA_MODEL_SPEC: ${modelSpecRaw} -> ${modelSpec}`,
				);
			}

			// Merge all tool sources into the module-level record (used by agent factory too)
			const mergedTools: Record<
				string,
				import("../types/tool.js").DurableAgentTool
			> = {
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

			// Store merged tools for agent factory (per-request config agents)
			allMergedTools = mergedTools;

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
				modelResolver: resolveNormalizedModel,
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
			if (!reconcileLoopStarted) {
				reconcileLoopStarted = true;
				void reconcileUnpublishedRuns();
				const timer = setInterval(() => {
					void reconcileUnpublishedRuns();
				}, RUN_RECONCILE_INTERVAL_MS);
				timer.unref();
			}
			console.log(
				"[durable-agent] Agent initialized and workflow runtime started",
			);
		} catch (err) {
			initialized = false;
			workflowClient = null;
			try {
				if (agent) {
					await agent.stop();
				}
			} catch {
				/* best effort */
			}
			agent = null;
			try {
				await sandbox.destroy();
			} catch {
				/* best effort */
			}
			throw err;
		} finally {
			initializingPromise = null;
		}
	})();

	await initializingPromise;
}

function scheduleStartupInitRetry(): void {
	if (initialized || startupInitRetryTimer) {
		return;
	}
	startupInitRetryTimer = setInterval(() => {
		if (initialized) {
			if (startupInitRetryTimer) {
				clearInterval(startupInitRetryTimer);
				startupInitRetryTimer = null;
			}
			return;
		}
		void (async () => {
			try {
				await initAgent();
				console.log(
					"[durable-agent] Startup retry succeeded (workflow runtime ready)",
				);
				if (startupInitRetryTimer) {
					clearInterval(startupInitRetryTimer);
					startupInitRetryTimer = null;
				}
			} catch (err) {
				console.warn(
					"[durable-agent] Startup retry initialization failed:",
					err instanceof Error ? err.message : String(err),
				);
			}
		})();
	}, STARTUP_INIT_RETRY_MS);
	startupInitRetryTimer.unref();
}

// ── File Change Extraction ────────────────────────────────────

type ToolCallRecord = { name: string; args: any; result: any };

type FileChange = {
	path: string;
	operation: "created" | "modified" | "deleted";
	content?: string;
};

type ChangeSummaryOutput = {
	changed: boolean;
	files: Array<{ path: string; op: string }>;
	stats: {
		files: number;
		additions: number;
		deletions: number;
	};
	patchRef?: string;
	patchSha256?: string;
	patchBytes?: number;
	truncatedInlinePatch?: boolean;
	inlinePatchPreview?: string;
	truncatedArtifact?: boolean;
	artifactOriginalBytes?: number;
	baseRevision?: string;
	headRevision?: string;
};

type PlanModePolicy = {
	readOnlyExpected: boolean;
	promptEnforced: boolean;
	usedMutatingTools: boolean;
	mutatingTools: string[];
	mutatingToolCalls: number;
	totalToolCalls: number;
};

function parseOptionalBoolean(input: unknown): boolean | undefined {
	if (typeof input === "boolean") return input;
	if (typeof input !== "string") return undefined;
	const normalized = input.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return undefined;
}

function parseOptionalLoopPolicy(input: unknown): LoopPolicy | undefined {
	if (!input) return undefined;
	if (typeof input === "string") {
		const trimmed = input.trim();
		if (!trimmed) return undefined;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as LoopPolicy;
			}
			return undefined;
		} catch (err) {
			console.warn("[durable-agent] Invalid loopPolicy JSON:", err);
			return undefined;
		}
	}
	if (typeof input === "object" && !Array.isArray(input)) {
		return input as LoopPolicy;
	}
	return undefined;
}

function isMutatingToolName(name: string): boolean {
	const normalized = name.trim().toLowerCase();
	if (!normalized) return false;
	return (
		normalized === "write_file" ||
		normalized === "edit_file" ||
		normalized === "delete_file" ||
		normalized === "mkdir" ||
		normalized === "execute_command" ||
		normalized === "clone" ||
		normalized.endsWith("write_file") ||
		normalized.endsWith("edit_file") ||
		normalized.endsWith("delete_file") ||
		normalized.endsWith("mkdir") ||
		normalized.endsWith("execute_command")
	);
}

function buildPlanModePolicy(toolCalls: ToolCallRecord[]): PlanModePolicy {
	const mutatingTools = [
		...new Set(toolCalls.map((tc) => tc.name).filter(isMutatingToolName)),
	].sort();
	return {
		readOnlyExpected: true,
		promptEnforced: true,
		usedMutatingTools: mutatingTools.length > 0,
		mutatingTools,
		mutatingToolCalls: toolCalls.filter((tc) => isMutatingToolName(tc.name))
			.length,
		totalToolCalls: toolCalls.length,
	};
}

function stopConditionImpliesFileChanges(stopCondition: string): boolean {
	const normalized = stopCondition.toLowerCase();
	const requiresChangeTerms = [
		"file changes",
		"files are updated",
		"code changes",
		"files updated",
		"changes are complete",
		"edited files",
		"modified files",
		"apply changes",
		"write files",
		"edit files",
	];
	return requiresChangeTerms.some((term) => normalized.includes(term));
}

function buildRunPrompt(
	basePrompt: string,
	stopCondition: string | undefined,
	requireFileChanges: boolean,
	cwd?: string,
): string {
	const normalizedCwd = cwd?.trim();
	const normalizedStopCondition = stopCondition?.trim();
	const cwdContext = normalizedCwd
		? `Repository root: ${normalizedCwd}\nAlways operate relative to this repository root for file and directory paths.\n\n`
		: "";
	if (!normalizedStopCondition) {
		return `${cwdContext}${basePrompt}`;
	}

	const fileChangeGuard = requireFileChanges
		? "\n\nCRITICAL: You must make real file mutations (write/edit/delete/mkdir) before finalizing. Do not stop at analysis or directory listing."
		: "";

	return `${cwdContext}${basePrompt}

## Stop Condition
${normalizedStopCondition}

Execute autonomously until the stop condition is satisfied. Do not ask for confirmation before proceeding.${fileChangeGuard}`;
}

function didRunMutateFiles(
	fileChanges: FileChange[],
	changeSummary?: ChangeSummaryOutput,
): boolean {
	if (fileChanges.length > 0) return true;
	return Boolean(changeSummary?.changed || changeSummary?.files.length);
}

function planHasExecutableTasks(plan: Plan): boolean {
	return plan.tasks.length > 0 && plan.steps.length > 0;
}

function buildPlanExecutionText(plan: Plan): string {
	return plan.tasks
		.map((task, index) => {
			const deps =
				task.blockedBy.length > 0
					? ` [blockedBy: ${task.blockedBy.join(", ")}]`
					: "";
			const why = task.reasoning ? ` — ${task.reasoning}` : "";
			return `${index + 1}. [${task.tool}] (${task.id}) ${task.title}: ${task.instructions}${why}${deps}`;
		})
		.join("\n");
}

function planTaskImpliesFileMutation(tool: string): boolean {
	const normalized = tool.trim().toLowerCase();
	if (!normalized) return false;
	return (
		normalized === "write_file" ||
		normalized === "edit_file" ||
		normalized === "delete_file" ||
		normalized === "mkdir" ||
		normalized.endsWith("write_file") ||
		normalized.endsWith("edit_file") ||
		normalized.endsWith("delete_file") ||
		normalized.endsWith("mkdir")
	);
}

function planLikelyRequiresFileChanges(plan: Plan): boolean {
	return plan.tasks.some((task) => planTaskImpliesFileMutation(task.tool));
}

/**
 * Extract tool calls from the workflow completion result.
 *
 * The agent workflow returns `all_tool_calls` (accumulated across all turns)
 * and `tool_calls` (from the final message only, usually empty).
 */
function extractToolCalls(
	result: Record<string, unknown> | undefined,
): ToolCallRecord[] {
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
		} else if (
			name === "delete_file" ||
			name === "delete" ||
			name.endsWith("delete")
		) {
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

async function buildAgentChangeSummary(
	executionId: string,
	durableInstanceId: string,
): Promise<ChangeSummaryOutput> {
	const { patch, changeSets } = await workspaceSessions.getExecutionPatch(
		executionId,
		{
			durableInstanceId,
		},
	);
	const files = changeSets.flatMap((set) =>
		set.files.map((file) => ({
			path: file.path,
			op:
				file.status === "A"
					? "created"
					: file.status === "D"
						? "deleted"
						: file.status === "R"
							? "renamed"
							: "modified",
		})),
	);
	const additions = changeSets.reduce((sum, set) => sum + set.additions, 0);
	const deletions = changeSets.reduce((sum, set) => sum + set.deletions, 0);
	const patchBytes = Buffer.byteLength(patch, "utf8");
	const previewLimit = parseInt(
		process.env.WORKSPACE_INLINE_PATCH_PREVIEW_BYTES || "16384",
		10,
	);

	return {
		changed: changeSets.length > 0,
		files,
		stats: {
			files: files.length,
			additions,
			deletions,
		},
		patchRef:
			changeSets.length > 0
				? `/api/workspaces/executions/${executionId}/patch?durableInstanceId=${durableInstanceId}`
				: undefined,
		patchSha256: undefined,
		patchBytes: patchBytes > 0 ? patchBytes : undefined,
		truncatedInlinePatch: patch.length > previewLimit,
		inlinePatchPreview: patch ? patch.slice(0, previewLimit) : undefined,
		baseRevision: changeSets[0]?.baseRevision,
		headRevision: changeSets.at(-1)?.headRevision,
	};
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
	console.log(
		`[durable-agent] Waiting for workflow completion: ${instanceId} (timeout=${timeoutSeconds}s)`,
	);

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
		console.log(
			`[durable-agent] Workflow ${instanceId} finished with status: ${statusNum}`,
		);

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

type PlanningAttemptResult = {
	instanceId: string;
	completion: {
		success: boolean;
		result?: Record<string, unknown>;
		error?: string;
	};
	toolCalls: ToolCallRecord[];
	planningText: string;
};

async function runPlanningAttempt(input: {
	activeAgent: DurableAgent;
	task: string;
	maxIterations: number;
	workspaceRef?: string;
	timeoutSeconds?: number;
	loopPolicy?: LoopPolicy;
}): Promise<PlanningAttemptResult> {
	const instanceId = await workflowClient!.scheduleNewWorkflow(
		input.activeAgent.agentWorkflow,
		{
			task: input.task,
			maxIterations: input.maxIterations,
			...(input.loopPolicy ? { loopPolicy: input.loopPolicy } : {}),
		},
	);
	if (input.workspaceRef) {
		await workspaceSessions.bindDurableInstance(instanceId, input.workspaceRef);
	}

	let completion: {
		success: boolean;
		result?: Record<string, unknown>;
		error?: string;
	};
	try {
		completion = await waitForWorkflowCompletion(
			instanceId,
			input.timeoutSeconds ?? PLAN_TIMEOUT_SECONDS,
		);
	} finally {
		workspaceSessions.unbindDurableInstance(instanceId);
	}

	const toolCalls = extractToolCalls(completion.result);
	const planningText =
		(completion.result?.final_answer as string) ??
		(completion.result?.last_message as string) ??
		(completion.result?.content as string) ??
		"";

	return {
		instanceId,
		completion,
		toolCalls,
		planningText,
	};
}

async function getWorkflowCompletionSnapshot(instanceId: string): Promise<{
	done: boolean;
	success: boolean;
	result?: Record<string, unknown>;
	error?: string;
}> {
	try {
		const state = await workflowClient!.getWorkflowState(instanceId, true);
		if (!state) {
			return { done: true, success: false, error: "Workflow state not found" };
		}
		const statusNum = state.runtimeStatus;
		if (statusNum === 1) {
			let result: Record<string, unknown> = {};
			if (state.serializedOutput) {
				try {
					result = JSON.parse(state.serializedOutput);
				} catch {
					result = { raw: state.serializedOutput };
				}
			}
			return { done: true, success: true, result };
		}
		if (statusNum === 3 || statusNum === 5) {
			let error = "Workflow failed";
			if ((state as any).failureDetails?.message) {
				error = (state as any).failureDetails.message;
			}
			return { done: true, success: false, error };
		}
		return { done: false, success: false };
	} catch (err) {
		return { done: false, success: false, error: String(err) };
	}
}

async function reconcileUnpublishedRuns(): Promise<void> {
	if (reconcilingRuns) return;
	reconcilingRuns = true;
	try {
		const pending = await workflowRunTracker.listPending(50);
		for (const run of pending) {
			try {
				let success = run.status === "completed";
				let error = run.error;
				let result = run.result;
				if (!result && !error) {
					const snapshot = await getWorkflowCompletionSnapshot(
						run.daprInstanceId,
					);
					if (!snapshot.done) {
						await workflowRunTracker.markReconciled(run.id);
						continue;
					}
					success = snapshot.success;
					error = snapshot.error;
					result = snapshot.result;
					await workflowRunTracker.markCompleted({
						id: run.id,
						success,
						result,
						error,
					});
				}

				const published = await publishCompletionEvent({
					agentWorkflowId: run.agentWorkflowId,
					parentExecutionId: run.parentExecutionId,
					success,
					result,
					error,
				});
				if (published) {
					await workflowRunTracker.markEventPublished(run.id);
				}
				await workflowRunTracker.markReconciled(run.id);
			} catch (err) {
				console.warn(`[durable-agent] reconcile run ${run.id} failed:`, err);
			}
		}
	} catch (err) {
		console.warn("[durable-agent] reconcileUnpublishedRuns failed:", err);
	} finally {
		reconcilingRuns = false;
	}
}

// ── Express Server ────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));

// Health check
app.get("/api/health", (_req, res) => {
	const state = eventBus.getState();
	const workspaceStats = workspaceSessions.getStats();
	res.json({
		service: "durable-agent",
		agentStatus: state.status,
		agentTools: TOOL_NAMES,
		totalRuns: state.totalRuns,
		totalTokens: state.totalTokens,
		activeWorkspaces: workspaceStats.activeWorkspaces,
		mappedWorkspaceInstances: workspaceStats.mappedInstances,
		initialized,
	});
});

// Readiness check (only ready after agent/runtime initialization)
app.get("/api/ready", (_req, res) => {
	if (!initialized) {
		res.status(503).json({
			service: "durable-agent",
			ready: false,
			initialized,
		});
		return;
	}
	res.json({
		service: "durable-agent",
		ready: true,
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

app.post("/api/workspaces/profile", async (req, res) => {
	try {
		const executionIdRaw = req.body?.executionId ?? req.body?.dbExecutionId;
		const executionId =
			typeof executionIdRaw === "string" ? executionIdRaw.trim() : "";
		if (!executionId) {
			res
				.status(400)
				.json({ success: false, error: "executionId is required" });
			return;
		}

		const profile = await workspaceSessions.createOrGetProfile({
			executionId,
			name: typeof req.body?.name === "string" ? req.body.name : undefined,
			rootPath:
				typeof req.body?.rootPath === "string" ? req.body.rootPath : undefined,
			enabledTools: Array.isArray(req.body?.enabledTools)
				? req.body.enabledTools
				: typeof req.body?.enabledTools === "string" &&
						req.body.enabledTools.trim()
					? (() => {
							try {
								const parsed = JSON.parse(req.body.enabledTools);
								return Array.isArray(parsed) ? parsed : undefined;
							} catch {
								return undefined;
							}
						})()
					: undefined,
			requireReadBeforeWrite:
				req.body?.requireReadBeforeWrite === true ||
				req.body?.requireReadBeforeWrite === "true",
			commandTimeoutMs:
				typeof req.body?.commandTimeoutMs === "number"
					? req.body.commandTimeoutMs
					: typeof req.body?.commandTimeoutMs === "string" &&
							req.body.commandTimeoutMs.trim()
						? parseInt(req.body.commandTimeoutMs, 10)
						: undefined,
		});

		res.json({ success: true, ...profile });
	} catch (err) {
		res.status(400).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

app.post("/api/workspaces/clone", async (req, res) => {
	try {
		const repositoryOwner =
			typeof req.body?.repositoryOwner === "string"
				? req.body.repositoryOwner
				: "";
		const repositoryRepo =
			typeof req.body?.repositoryRepo === "string"
				? req.body.repositoryRepo
				: "";
		if (!repositoryOwner.trim() || !repositoryRepo.trim()) {
			res.status(400).json({
				success: false,
				error: "repositoryOwner and repositoryRepo are required",
			});
			return;
		}

		const result = await workspaceSessions.cloneRepository({
			workspaceRef:
				typeof req.body?.workspaceRef === "string"
					? req.body.workspaceRef
					: undefined,
			executionId:
				typeof req.body?.executionId === "string"
					? req.body.executionId
					: typeof req.body?.dbExecutionId === "string"
						? req.body.dbExecutionId
						: undefined,
			durableInstanceId:
				typeof req.body?.durableInstanceId === "string"
					? req.body.durableInstanceId
					: typeof req.body?.__durable_instance_id === "string"
						? req.body.__durable_instance_id
						: undefined,
			repositoryOwner,
			repositoryRepo,
			repositoryBranch:
				typeof req.body?.repositoryBranch === "string"
					? req.body.repositoryBranch
					: undefined,
			targetDir:
				typeof req.body?.targetDir === "string"
					? req.body.targetDir
					: undefined,
			repositoryToken:
				typeof req.body?.repositoryToken === "string"
					? req.body.repositoryToken
					: undefined,
			githubToken:
				typeof req.body?.githubToken === "string"
					? req.body.githubToken
					: undefined,
			timeoutMs:
				typeof req.body?.timeoutMs === "number"
					? req.body.timeoutMs
					: typeof req.body?.timeoutMs === "string" && req.body.timeoutMs.trim()
						? parseInt(req.body.timeoutMs, 10)
						: undefined,
		});

		res.json({ success: true, result });
	} catch (err) {
		res.status(400).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

app.post("/api/workspaces/command", async (req, res) => {
	try {
		const command =
			typeof req.body?.command === "string" ? req.body.command : "";
		if (!command.trim()) {
			res.status(400).json({ success: false, error: "command is required" });
			return;
		}

		const result = await workspaceSessions.executeCommand({
			workspaceRef:
				typeof req.body?.workspaceRef === "string"
					? req.body.workspaceRef
					: undefined,
			executionId:
				typeof req.body?.executionId === "string"
					? req.body.executionId
					: typeof req.body?.dbExecutionId === "string"
						? req.body.dbExecutionId
						: undefined,
			durableInstanceId:
				typeof req.body?.durableInstanceId === "string"
					? req.body.durableInstanceId
					: typeof req.body?.__durable_instance_id === "string"
						? req.body.__durable_instance_id
						: undefined,
			command,
			timeoutMs:
				typeof req.body?.timeoutMs === "number"
					? req.body.timeoutMs
					: typeof req.body?.timeoutMs === "string" && req.body.timeoutMs.trim()
						? parseInt(req.body.timeoutMs, 10)
						: undefined,
		});

		res.json({ success: true, result });
	} catch (err) {
		res.status(400).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

app.post("/api/workspaces/file", async (req, res) => {
	try {
		const operationRaw = req.body?.operation;
		const operation =
			typeof operationRaw === "string" ? operationRaw.trim() : "";
		if (
			![
				"read_file",
				"write_file",
				"edit_file",
				"list_files",
				"delete_file",
				"mkdir",
				"file_stat",
			].includes(operation)
		) {
			res.status(400).json({
				success: false,
				error:
					"operation is required and must be one of read_file, write_file, edit_file, list_files, delete_file, mkdir, file_stat",
			});
			return;
		}

		const result = await workspaceSessions.executeFileOperation({
			workspaceRef:
				typeof req.body?.workspaceRef === "string"
					? req.body.workspaceRef
					: undefined,
			executionId:
				typeof req.body?.executionId === "string"
					? req.body.executionId
					: typeof req.body?.dbExecutionId === "string"
						? req.body.dbExecutionId
						: undefined,
			durableInstanceId:
				typeof req.body?.durableInstanceId === "string"
					? req.body.durableInstanceId
					: typeof req.body?.__durable_instance_id === "string"
						? req.body.__durable_instance_id
						: undefined,
			operation: operation as
				| "read_file"
				| "write_file"
				| "edit_file"
				| "list_files"
				| "delete_file"
				| "mkdir"
				| "file_stat",
			path: typeof req.body?.path === "string" ? req.body.path : undefined,
			content:
				typeof req.body?.content === "string" ? req.body.content : undefined,
			old_string:
				typeof req.body?.old_string === "string"
					? req.body.old_string
					: undefined,
			new_string:
				typeof req.body?.new_string === "string"
					? req.body.new_string
					: undefined,
		});

		res.json({ success: true, result });
	} catch (err) {
		res.status(400).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

app.post("/api/workspaces/cleanup", async (req, res) => {
	try {
		const workspaceRef =
			typeof req.body?.workspaceRef === "string"
				? req.body.workspaceRef.trim()
				: "";
		const executionId =
			typeof req.body?.executionId === "string"
				? req.body.executionId.trim()
				: "";
		const dbExecutionId =
			typeof req.body?.dbExecutionId === "string"
				? req.body.dbExecutionId.trim()
				: "";

		if (!workspaceRef && !executionId && !dbExecutionId) {
			res.status(400).json({
				success: false,
				error: "workspaceRef, executionId, or dbExecutionId is required",
			});
			return;
		}

		const cleanedRefs: string[] = [];
		if (workspaceRef) {
			const cleaned =
				await workspaceSessions.cleanupByWorkspaceRef(workspaceRef);
			if (cleaned) cleanedRefs.push(workspaceRef);
		}
		if (executionId) {
			const refs = await workspaceSessions.cleanupByExecutionId(executionId);
			for (const ref of refs) cleanedRefs.push(ref);
		}
		if (dbExecutionId && dbExecutionId !== executionId) {
			const refs = await workspaceSessions.cleanupByExecutionId(dbExecutionId);
			for (const ref of refs) cleanedRefs.push(ref);
		}

		res.json({
			success: true,
			cleanedWorkspaceRefs: [...new Set(cleanedRefs)],
		});
	} catch (err) {
		res.status(400).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

app.get("/api/workspaces/changes/:changeSetId", async (req, res) => {
	try {
		const changeSetId =
			typeof req.params.changeSetId === "string"
				? req.params.changeSetId.trim()
				: "";
		if (!changeSetId) {
			res
				.status(400)
				.json({ success: false, error: "changeSetId is required" });
			return;
		}

		const artifact = await workspaceSessions.getChangeArtifact(changeSetId);
		if (!artifact) {
			res
				.status(404)
				.json({ success: false, error: "Change artifact not found" });
			return;
		}

		res.json({
			success: true,
			metadata: artifact.metadata,
			patch: artifact.patch,
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

app.get("/api/workspaces/executions/:executionId/changes", async (req, res) => {
	try {
		const executionId =
			typeof req.params.executionId === "string"
				? req.params.executionId.trim()
				: "";
		if (!executionId) {
			res
				.status(400)
				.json({ success: false, error: "executionId is required" });
			return;
		}

		const changes =
			await workspaceSessions.listChangeArtifactsByExecutionId(executionId);
		res.json({
			success: true,
			executionId,
			count: changes.length,
			changes,
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

app.get("/api/workspaces/executions/:executionId/patch", async (req, res) => {
	try {
		const executionId =
			typeof req.params.executionId === "string"
				? req.params.executionId.trim()
				: "";
		if (!executionId) {
			res
				.status(400)
				.json({ success: false, error: "executionId is required" });
			return;
		}

		const durableInstanceId =
			typeof req.query?.durableInstanceId === "string"
				? req.query.durableInstanceId.trim()
				: undefined;
		const combined = await workspaceSessions.getExecutionPatch(executionId, {
			durableInstanceId,
		});

		if (req.query?.format === "raw") {
			res.setHeader("Content-Type", "text/plain; charset=utf-8");
			res.send(combined.patch);
			return;
		}

		res.json({
			success: true,
			executionId,
			durableInstanceId,
			patch: combined.patch,
			changeSets: combined.changeSets,
		});
	} catch (err) {
		res.status(500).json({
			success: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
});

app.get(
	"/api/workspaces/executions/:executionId/files/snapshot",
	async (req, res) => {
		try {
			const executionId =
				typeof req.params.executionId === "string"
					? req.params.executionId.trim()
					: "";
			if (!executionId) {
				res
					.status(400)
					.json({ success: false, error: "executionId is required" });
				return;
			}

			const filePath =
				typeof req.query?.path === "string" ? req.query.path.trim() : "";
			if (!filePath) {
				res.status(400).json({ success: false, error: "path is required" });
				return;
			}

			const durableInstanceId =
				typeof req.query?.durableInstanceId === "string"
					? req.query.durableInstanceId.trim()
					: undefined;
			const snapshot = await workspaceSessions.getExecutionFileSnapshot(
				executionId,
				filePath,
				{
					durableInstanceId,
				},
			);
			if (!snapshot) {
				res.status(404).json({
					success: false,
					error: "File snapshot not found for execution",
				});
				return;
			}

			res.json({
				success: true,
				executionId,
				path: filePath,
				durableInstanceId,
				snapshot,
			});
		} catch (err) {
			res.status(500).json({
				success: false,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	},
);

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
		const executionIdRaw =
			(req.body?.executionId as string) ??
			(req.body?.dbExecutionId as string) ??
			parentExecutionId;
		const executionId = String(executionIdRaw || "").trim();
		const nodeId = (req.body?.nodeId as string) ?? "";
		const workflowId =
			typeof req.body?.workflowId === "string"
				? req.body.workflowId.trim()
				: "";
		const agentWorkflowId = `durable-run-${nanoid(12)}`;
		const requestedWorkspaceRef =
			typeof req.body?.workspaceRef === "string"
				? req.body.workspaceRef.trim()
				: "";
		const workspaceRef =
			requestedWorkspaceRef ||
			(executionId
				? (await workspaceSessions.getWorkspaceRefByExecutionIdDurable(
						executionId,
					)) || ""
				: "");
		const stopCondition =
			typeof req.body?.stopCondition === "string"
				? req.body.stopCondition.trim()
				: "";
		const loopPolicy = parseOptionalLoopPolicy(req.body?.loopPolicy);
		const cwd = typeof req.body?.cwd === "string" ? req.body.cwd.trim() : "";
		const explicitRequireFileChanges = parseOptionalBoolean(
			req.body?.requireFileChanges,
		);
		const requireFileChanges =
			explicitRequireFileChanges ??
			(Boolean(workspaceRef) &&
				Boolean(stopCondition) &&
				stopConditionImpliesFileChanges(stopCondition));
		const runPrompt = buildRunPrompt(
			prompt,
			stopCondition,
			requireFileChanges,
			cwd,
		);
		if (workspaceRef) {
			const session =
				await workspaceSessions.getByWorkspaceRefDurable(workspaceRef);
			if (!session) {
				res.status(400).json({
					success: false,
					error: `workspaceRef not found: ${workspaceRef}`,
				});
				return;
			}
		}

		// Set workflow context on eventBus
		eventBus.setWorkflowContext({
			workflowId: agentWorkflowId,
			nodeId,
			stepIndex: 0,
		});

		console.log(
			`[durable-agent] /api/run: agentWorkflowId=${agentWorkflowId} prompt="${runPrompt.slice(0, 80)}"`,
		);

		// Per-request maxTurns override
		const maxTurns = req.body?.maxTurns
			? parseInt(String(req.body.maxTurns), 10)
			: undefined;

		// Resolve agent: use per-request agentConfig if provided, otherwise default
		const agentConfig =
			req.body?.agentConfig && typeof req.body.agentConfig === "object"
				? (req.body.agentConfig as AgentConfigPayload)
				: undefined;
		let activeAgent = agent!;
		let activeAgentOverridden = false;
		if (
			agentConfig?.name &&
			agentConfig?.instructions &&
			agentConfig?.modelSpec
		) {
			try {
				activeAgent = await getOrCreateConfiguredAgent(agentConfig);
				activeAgentOverridden = true;
				console.log(
					`[durable-agent] Using configured agent: ${agentConfig.name}`,
				);
			} catch (err) {
				console.warn(
					`[durable-agent] Failed to create configured agent, falling back to default:`,
					err,
				);
			}
		}

		// Inline config fallback: when no saved agent but model/instructions provided inline
		if (!activeAgentOverridden && req.body?.model) {
			const toolsRaw = req.body.tools;
			let toolsList: string[] = [];
			if (typeof toolsRaw === "string") {
				try {
					toolsList = JSON.parse(toolsRaw) as string[];
				} catch {
					/* ignore */
				}
			} else if (Array.isArray(toolsRaw)) {
				toolsList = toolsRaw.filter((t): t is string => typeof t === "string");
			}

			const inlineConfig: AgentConfigPayload = {
				name: "inline-agent",
				instructions: (req.body.instructions as string) || "",
				modelSpec: req.body.model as string,
				tools: toolsList.length > 0 ? toolsList : undefined,
			};
			if (inlineConfig.modelSpec) {
				try {
					activeAgent = await getOrCreateConfiguredAgent(inlineConfig);
					console.log(
						`[durable-agent] Using inline agent config: model=${inlineConfig.modelSpec}`,
					);
				} catch (err) {
					console.warn(
						`[durable-agent] Failed to create inline agent, falling back to default:`,
						err,
					);
				}
			}
		}

		// Schedule the durable agent workflow
		const instanceId = await workflowClient!.scheduleNewWorkflow(
			activeAgent.agentWorkflow,
			{
				task: runPrompt,
				...(maxTurns ? { maxIterations: maxTurns } : {}),
				...(loopPolicy ? { loopPolicy } : {}),
			},
		);
		if (workspaceRef) {
			await workspaceSessions.bindDurableInstance(instanceId, workspaceRef);
		}

		console.log(
			`[durable-agent] Scheduled Dapr workflow: instance=${instanceId} maxTurns=${maxTurns ?? "default"}`,
		);
		const trackedRunId = agentWorkflowId;
		if (executionId && workflowId && nodeId) {
			await workflowRunTracker.trackScheduled({
				id: trackedRunId,
				workflowExecutionId: executionId,
				workflowId,
				nodeId,
				mode: "run",
				agentWorkflowId,
				daprInstanceId: instanceId,
				parentExecutionId,
				workspaceRef: workspaceRef || undefined,
			});
		}

		// Fire-and-forget: wait for completion in background, then publish
		(async () => {
			console.log(
				`[durable-agent] Background: starting completion wait for ${instanceId} (parent=${parentExecutionId})`,
			);
			try {
				const completion = await waitForWorkflowCompletion(instanceId);

				// Extract tool calls from all turns
				const toolCalls = extractToolCalls(completion.result);
				const fileChanges = extractFileChanges(toolCalls);
				const changeSummary =
					workspaceRef && executionId
						? await buildAgentChangeSummary(executionId, instanceId)
						: undefined;
				const hasFileMutations = didRunMutateFiles(fileChanges, changeSummary);
				const fileChangeGuardViolation =
					requireFileChanges && completion.success && !hasFileMutations
						? "Stop condition requires file changes, but this run completed without write/edit/delete operations."
						: undefined;

				// Extract text from the final message
				const text =
					(completion.result?.final_answer as string) ??
					(completion.result?.last_message as string) ??
					(completion.result?.content as string) ??
					JSON.stringify(completion.result ?? {});

				// Run post-workflow scorers (outside Dapr generator)
				let evalResults: unknown[] | undefined;
				if (
					scorers.length > 0 &&
					completion.success &&
					!fileChangeGuardViolation
				) {
					evalResults = await runScorers(scorers, runPrompt, text, instanceId);
				}
				const completionSuccess =
					completion.success && !fileChangeGuardViolation;
				const completionResult = {
					text,
					toolCalls,
					staticToolCalls:
						(completion.result?.static_tool_calls as unknown[]) ?? undefined,
					loopStopReason:
						(typeof completion.result?.stop_reason === "string"
							? completion.result.stop_reason
							: undefined) ?? undefined,
					loopStopCondition: completion.result?.stop_condition,
					requiresApproval: completion.result?.requires_approval,
					usageTotals: completion.result?.usage_totals,
					fileChanges,
					patch: changeSummary?.inlinePatchPreview,
					patchRef: changeSummary?.patchRef,
					changeSummary,
					daprInstanceId: instanceId,
					...(evalResults ? { evalResults } : {}),
				};
				if (executionId && workflowId && nodeId) {
					await workflowRunTracker.markCompleted({
						id: trackedRunId,
						success: completionSuccess,
						result: completionResult,
						error: fileChangeGuardViolation || completion.error,
					});
				}

				const published = await publishCompletionEvent({
					agentWorkflowId,
					parentExecutionId,
					success: completionSuccess,
					result: completionResult,
					error: fileChangeGuardViolation || completion.error,
				});
				if (published && executionId && workflowId && nodeId) {
					await workflowRunTracker.markEventPublished(trackedRunId);
				}
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				console.error(`[durable-agent] Background run failed: ${errorMsg}`);
				if (executionId && workflowId && nodeId) {
					await workflowRunTracker.markCompleted({
						id: trackedRunId,
						success: false,
						error: errorMsg,
					});
				}
				const published = await publishCompletionEvent({
					agentWorkflowId,
					parentExecutionId,
					success: false,
					error: errorMsg,
				});
				if (published && executionId && workflowId && nodeId) {
					await workflowRunTracker.markEventPublished(trackedRunId);
				}
			} finally {
				workspaceSessions.unbindDurableInstance(instanceId);
			}
		})();

		// Return immediately
		res.json({
			success: true,
			workflow_id: agentWorkflowId,
			dapr_instance_id: instanceId,
			...(workspaceRef ? { workspaceRef } : {}),
		});
	} catch (err) {
		res.status(400).json({ success: false, error: String(err) });
	}
});

// Plan endpoint (synchronous)
app.post("/api/plan", async (req, res) => {
	try {
		const prompt =
			typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";
		if (!prompt) {
			res.status(400).json({ success: false, error: "prompt is required" });
			return;
		}

		await initAgent();

		const executionIdRaw =
			(req.body?.executionId as string) ??
			(req.body?.dbExecutionId as string) ??
			(req.body?.parentExecutionId as string) ??
			"";
		const executionId = String(executionIdRaw || "").trim();
		const workflowId =
			typeof req.body?.workflowId === "string"
				? req.body.workflowId.trim()
				: "";
		const nodeId =
			typeof req.body?.nodeId === "string" ? req.body.nodeId.trim() : "";
		const parentExecutionId =
			typeof req.body?.parentExecutionId === "string"
				? req.body.parentExecutionId.trim()
				: "";
		let cwd = typeof req.body?.cwd === "string" ? req.body.cwd.trim() : "";
		const requestedWorkspaceRef =
			typeof req.body?.workspaceRef === "string"
				? req.body.workspaceRef.trim()
				: "";
		const workspaceRef =
			requestedWorkspaceRef ||
			(executionId
				? (await workspaceSessions.getWorkspaceRefByExecutionIdDurable(
						executionId,
					)) || ""
				: "");
		const session = workspaceRef
			? await workspaceSessions.getByWorkspaceRefDurable(workspaceRef)
			: null;
		if (workspaceRef && !session) {
			res.status(400).json({
				success: false,
				error: `workspaceRef not found: ${workspaceRef}`,
			});
			return;
		}
		if (!cwd && session) {
			cwd = session.clonePath || session.rootPath;
		}

		const maxTurnsRaw = req.body?.maxTurns;
		let planningMaxTurns = 24;
		if (maxTurnsRaw != null) {
			const parsed = Number.parseInt(String(maxTurnsRaw), 10);
			if (Number.isFinite(parsed) && parsed > 0) {
				planningMaxTurns = parsed;
			}
		}
		const loopPolicy = parseOptionalLoopPolicy(req.body?.loopPolicy);

		// Resolve agent: prefer explicit agentConfig, then inline model config, else default.
		const agentConfig =
			req.body?.agentConfig && typeof req.body.agentConfig === "object"
				? (req.body.agentConfig as AgentConfigPayload)
				: undefined;
		let activeAgent = agent!;
		let activeAgentOverridden = false;
		if (
			agentConfig?.name &&
			agentConfig?.instructions &&
			agentConfig?.modelSpec
		) {
			try {
				activeAgent = await getOrCreateConfiguredAgent(agentConfig);
				activeAgentOverridden = true;
			} catch (err) {
				console.warn(
					`[durable-agent] Failed to create configured planning agent, falling back to default:`,
					err,
				);
			}
		}
		if (!activeAgentOverridden && req.body?.model) {
			const toolsRaw = req.body.tools;
			let toolsList: string[] = [];
			if (typeof toolsRaw === "string") {
				try {
					toolsList = JSON.parse(toolsRaw) as string[];
				} catch {
					/* ignore */
				}
			} else if (Array.isArray(toolsRaw)) {
				toolsList = toolsRaw.filter((t): t is string => typeof t === "string");
			}

			const inlineConfig: AgentConfigPayload = {
				name: "inline-plan-agent",
				instructions: (req.body.instructions as string) || "",
				modelSpec: req.body.model as string,
				tools: toolsList.length > 0 ? toolsList : undefined,
				maxTurns: planningMaxTurns,
			};
			if (inlineConfig.modelSpec) {
				try {
					activeAgent = await getOrCreateConfiguredAgent(inlineConfig);
				} catch (err) {
					console.warn(
						`[durable-agent] Failed to create inline planning agent, falling back to default:`,
						err,
					);
				}
			}
		}

		const planningPrompt = buildPlanModePrompt({
			userPrompt: prompt,
			repositoryRoot: cwd || undefined,
		});
		eventBus.emitEvent("planning_started", { prompt, planningMaxTurns });

		const planningInstanceIds: string[] = [];
		const planningTexts: string[] = [];
		const toolCalls: ToolCallRecord[] = [];

		const initialPlanningAttempt = await runPlanningAttempt({
			activeAgent,
			task: planningPrompt.prompt,
			maxIterations: planningMaxTurns,
			workspaceRef: workspaceRef || undefined,
			loopPolicy,
		});
		planningInstanceIds.push(initialPlanningAttempt.instanceId);

		if (!initialPlanningAttempt.completion.success) {
			res.status(500).json({
				success: false,
				error:
					initialPlanningAttempt.completion.error || "Plan mode run failed",
			});
			return;
		}

		toolCalls.push(...initialPlanningAttempt.toolCalls);
		planningTexts.push(initialPlanningAttempt.planningText);

		let planningText = initialPlanningAttempt.planningText;
		const initialExtractedPlan = extractProposedPlanText(planningText);
		let extractedPlan = initialExtractedPlan;
		let repairAttemptsUsed = 0;

		while (
			!extractedPlan?.trim() &&
			repairAttemptsUsed < PLAN_REPAIR_ATTEMPTS
		) {
			repairAttemptsUsed += 1;
			const repairPrompt = buildPlanRepairPrompt({
				userPrompt: prompt,
				priorResponse: planningText,
				attempt: repairAttemptsUsed,
				repositoryRoot: cwd || undefined,
				promptProfile: planningPrompt.profile,
			});
			const repairAttempt = await runPlanningAttempt({
				activeAgent,
				task: repairPrompt.prompt,
				maxIterations: PLAN_REPAIR_MAX_TURNS,
				workspaceRef: workspaceRef || undefined,
				loopPolicy,
			});
			planningInstanceIds.push(repairAttempt.instanceId);
			if (!repairAttempt.completion.success) {
				res.status(500).json({
					success: false,
					error: {
						code: "PLAN_MODE_REPAIR_FAILED",
						message:
							repairAttempt.completion.error ||
							"Plan mode repair attempt failed",
						details: {
							promptProfile: planningPrompt.profile,
							repairAttempt: repairAttemptsUsed,
							planningInstanceIds,
						},
					},
				});
				return;
			}
			toolCalls.push(...repairAttempt.toolCalls);
			planningText = repairAttempt.planningText;
			planningTexts.push(planningText);
			extractedPlan = extractProposedPlanText(planningText);
		}

		const planPolicy = buildPlanModePolicy(toolCalls);
		const planningTranscript =
			planningTexts.length > 0 ? planningTexts.join("\n\n") : planningText;
		const planEnvelope = {
			hasProposedPlanBlock: Boolean(extractedPlan),
			extracted: Boolean(extractedPlan?.trim()),
			fallbackUsed: false,
			repairAttemptsUsed,
			repairAttemptsConfigured: PLAN_REPAIR_ATTEMPTS,
			repaired: repairAttemptsUsed > 0 && Boolean(extractedPlan?.trim()),
			initialAttemptHasProposedPlanBlock: Boolean(initialExtractedPlan),
			initialAttemptExtracted: Boolean(initialExtractedPlan?.trim()),
			attempts: planningInstanceIds.length,
		};
		if (!extractedPlan?.trim()) {
			res.status(422).json({
				success: false,
				error: {
					code: "PLAN_MODE_PROPOSED_PLAN_REQUIRED",
					message:
						"Plan mode response must include a non-empty <proposed_plan>...</proposed_plan> block",
					details: {
						promptProfile: planningPrompt.profile,
						planEnvelope,
						planningInstanceIds,
					},
				},
			});
			return;
		}
		const planMarkdown = extractedPlan.trim();
		const planWarnings: string[] = [];
		if (repairAttemptsUsed > 0) {
			planWarnings.push(
				`Recovered required <proposed_plan> block via ${repairAttemptsUsed} repair attempt${repairAttemptsUsed === 1 ? "" : "s"}`,
			);
		}
		const planningNarrative =
			stripProposedPlanBlocks(planningTranscript).trim();

		const { plan, meta: generationMeta } = await generatePlanFromMarkdown({
			userPrompt: prompt,
			planMarkdown,
		});
		let artifactRef: string | undefined;
		if (executionId && workflowId && nodeId) {
			try {
				const artifact = await planArtifacts.save({
					workflowExecutionId: executionId,
					workflowId,
					nodeId,
					workspaceRef: workspaceRef || undefined,
					clonePath: cwd || undefined,
					goal: plan.goal,
					plan: plan as unknown as Record<string, unknown>,
					planMarkdown,
					sourcePrompt: prompt,
					metadata: {
						repositoryRoot: cwd || undefined,
						artifactType:
							(plan as { artifactType?: string }).artifactType ||
							"task_graph_v1",
						generationMeta,
						planPolicy,
						promptProfile: planningPrompt.profile,
						planEnvelope,
						planWarnings,
						planningNarrative: planningNarrative || undefined,
						planningInstanceIds,
						parentExecutionId: parentExecutionId || undefined,
					},
				});
				artifactRef = artifact.artifactRef;
			} catch (err) {
				console.error(
					`[durable-agent] Failed to persist plan artifact for execution=${executionId}:`,
					err,
				);
			}
		}

		eventBus.emitEvent("planning_completed", {
			goal: plan.goal,
			stepCount:
				Array.isArray((plan as { tasks?: unknown[] }).tasks) &&
				(plan as { tasks?: unknown[] }).tasks
					? (plan as { tasks?: unknown[] }).tasks?.length
					: plan.steps.length,
			estimatedToolCalls: plan.estimated_tool_calls,
			toolCalls: toolCalls.length,
		});

		res.json({
			success: true,
			plan,
			artifactRef,
			schemaVersion: "task_graph_v1",
			generationMeta,
			planMarkdown,
			planPolicy,
			promptProfile: planningPrompt.profile,
			planEnvelope,
			planWarnings,
			toolCalls,
			tasks: (plan as { tasks?: unknown[] }).tasks ?? [],
			...(workspaceRef ? { workspaceRef } : {}),
			daprPlanningInstanceId: planningInstanceIds[0],
			daprPlanningInstanceIds: planningInstanceIds,
		});
	} catch (err) {
		if (err instanceof PlanGenerationError) {
			res.status(422).json({
				success: false,
				error: {
					code: err.code,
					message: err.message,
					attempts: err.attempts,
					strategy: err.strategy,
					details: err.details,
				},
			});
			return;
		}
		res.status(500).json({ success: false, error: String(err) });
	}
});

// Execute plan endpoint (fire-and-forget)
app.post("/api/execute-plan", async (req, res) => {
	try {
		let planInput = req.body?.plan as unknown;
		const artifactRefRaw =
			typeof req.body?.artifactRef === "string" ? req.body.artifactRef : "";
		const artifactRef = artifactRefRaw.trim();
		const cwd = (req.body?.cwd as string) ?? "";
		const prompt = (req.body?.prompt as string) ?? "";
		const parentExecutionId = (req.body?.parentExecutionId as string) ?? "";
		const executionIdRaw =
			(req.body?.executionId as string) ??
			(req.body?.dbExecutionId as string) ??
			parentExecutionId;
		const executionId = String(executionIdRaw || "").trim();
		const workflowId =
			typeof req.body?.workflowId === "string"
				? req.body.workflowId.trim()
				: "";
		const nodeId =
			typeof req.body?.nodeId === "string" ? req.body.nodeId.trim() : "";
		const cleanupWorkspaceRequested = parseOptionalBoolean(
			req.body?.cleanupWorkspace,
		);
		const cleanupWorkspace = cleanupWorkspaceRequested ?? true;
		const loopPolicy = parseOptionalLoopPolicy(req.body?.loopPolicy);
		const agentWorkflowId = `durable-exec-${nanoid(12)}`;
		const requestedWorkspaceRef =
			typeof req.body?.workspaceRef === "string"
				? req.body.workspaceRef.trim()
				: "";
		let workspaceRef =
			requestedWorkspaceRef ||
			(executionId
				? (await workspaceSessions.getWorkspaceRefByExecutionIdDurable(
						executionId,
					)) || ""
				: "");
		let resolvedCwd = cwd.trim();
		if (!planInput && artifactRef) {
			const artifact = await planArtifacts.get(artifactRef);
			if (!artifact) {
				res.status(404).json({
					success: false,
					error: `Plan artifact not found: ${artifactRef}`,
				});
				return;
			}
			const artifactPlan = artifact.plan as unknown;
			if (artifactPlan && typeof artifactPlan === "object") {
				planInput = artifactPlan;
			}
			if (!workspaceRef && artifact.workspaceRef) {
				workspaceRef = artifact.workspaceRef;
			}
			if (!resolvedCwd && artifact.clonePath) {
				resolvedCwd = artifact.clonePath;
			}
		}
		if (
			workspaceRef &&
			!(await workspaceSessions.getByWorkspaceRefDurable(workspaceRef))
		) {
			res.status(400).json({
				success: false,
				error: `workspaceRef not found: ${workspaceRef}`,
			});
			return;
		}

		const parsedPlan = validatePlanForExecution(planInput);
		if (!parsedPlan.success) {
			res.status(400).json({
				success: false,
				error: {
					code: "INVALID_PLAN_SCHEMA",
					message:
						"Plan must match canonical task_graph_v1 schema with non-empty tasks and steps",
					details: parsedPlan.issues,
				},
			});
			return;
		}
		const plan: Plan = parsedPlan.plan;
		if (!planHasExecutableTasks(plan)) {
			res.status(400).json({
				success: false,
				error: {
					code: "INVALID_PLAN_SCHEMA",
					message: "Plan must contain executable tasks",
				},
			});
			return;
		}
		const explicitRequireFileChanges = parseOptionalBoolean(
			req.body?.requireFileChanges,
		);
		const requireFileChanges =
			explicitRequireFileChanges ?? planLikelyRequiresFileChanges(plan);
		if (artifactRef) {
			await planArtifacts.markStatus(artifactRef, "approved");
		}

		await initAgent();

		eventBus.setWorkflowContext({
			workflowId: agentWorkflowId,
			nodeId: (req.body?.nodeId as string) ?? "",
			stepIndex: 0,
		});

		// Build execution prompt with plan injected
		const planText = buildPlanExecutionText(plan);
		const cwdContext = resolvedCwd
			? `Working directory: ${resolvedCwd}\n\n`
			: "";
		const mutationRequirement = requireFileChanges
			? "\nCRITICAL: This execution requires real file mutations. Before finalizing, you MUST perform write/edit/delete/mkdir operations and produce concrete file changes."
			: "";
		const executionPrompt = `${cwdContext}You are now in EXECUTION MODE.\nDo not ask for more planning or approval. Do not ask clarifying questions. Execute immediately.\n\n## Task\n${prompt || plan.goal}\n\n## Execution Plan\nFollow this plan step-by-step:\n${planText}\n\nIMPORTANT: Execute all applicable steps with tools. If a planned path is missing or inaccurate, locate the correct file(s) in this repository and continue. If a step fails, record the error and proceed with the next step.${mutationRequirement}`;

		// Per-request maxTurns override
		const maxTurns = req.body?.maxTurns
			? parseInt(String(req.body.maxTurns), 10)
			: undefined;

		// Schedule workflow
		const instanceId = await workflowClient!.scheduleNewWorkflow(
			agent!.agentWorkflow,
			{
				task: executionPrompt,
				...(maxTurns ? { maxIterations: maxTurns } : {}),
				...(loopPolicy ? { loopPolicy } : {}),
			},
		);
		if (workspaceRef) {
			await workspaceSessions.bindDurableInstance(instanceId, workspaceRef);
		}
		const trackedRunId = agentWorkflowId;
		if (executionId && workflowId && nodeId) {
			await workflowRunTracker.trackScheduled({
				id: trackedRunId,
				workflowExecutionId: executionId,
				workflowId,
				nodeId,
				mode: "execute_plan",
				agentWorkflowId,
				daprInstanceId: instanceId,
				parentExecutionId,
				workspaceRef: workspaceRef || undefined,
				artifactRef: artifactRef || undefined,
			});
		}

		// Fire-and-forget
		(async () => {
			try {
				const completion = await waitForWorkflowCompletion(instanceId);

				// Extract tool calls from all turns
				const toolCalls = extractToolCalls(completion.result);
				const fileChanges = extractFileChanges(toolCalls);
				const changeSummary =
					workspaceRef && executionId
						? await buildAgentChangeSummary(executionId, instanceId)
						: undefined;
				const hasFileMutations = didRunMutateFiles(fileChanges, changeSummary);
				const fileChangeGuardViolation =
					requireFileChanges && completion.success && !hasFileMutations
						? "Execution plan required file changes, but the agent completed without write/edit/delete operations."
						: undefined;

				const text =
					(completion.result?.final_answer as string) ??
					(completion.result?.last_message as string) ??
					(completion.result?.content as string) ??
					JSON.stringify(completion.result ?? {});
				let cleanup: {
					requested: boolean;
					performed: boolean;
					success: boolean;
					workspaceRef?: string;
					error?: string;
				} = {
					requested: cleanupWorkspace,
					performed: false,
					success: !cleanupWorkspace || !workspaceRef,
				};
				if (cleanupWorkspace && workspaceRef) {
					try {
						const cleaned =
							await workspaceSessions.cleanupByWorkspaceRef(workspaceRef);
						cleanup = {
							requested: true,
							performed: true,
							success: cleaned,
							workspaceRef,
						};
					} catch (cleanupErr) {
						cleanup = {
							requested: true,
							performed: true,
							success: false,
							workspaceRef,
							error:
								cleanupErr instanceof Error
									? cleanupErr.message
									: String(cleanupErr),
						};
					}
				}
				const completionResult = {
					text,
					toolCalls,
					staticToolCalls:
						(completion.result?.static_tool_calls as unknown[]) ?? undefined,
					loopStopReason:
						(typeof completion.result?.stop_reason === "string"
							? completion.result.stop_reason
							: undefined) ?? undefined,
					loopStopCondition: completion.result?.stop_condition,
					requiresApproval: completion.result?.requires_approval,
					usageTotals: completion.result?.usage_totals,
					fileChanges,
					patch: changeSummary?.inlinePatchPreview,
					patchRef: changeSummary?.patchRef,
					changeSummary,
					requireFileChanges,
					hasFileMutations,
					plan,
					artifactRef: artifactRef || undefined,
					daprInstanceId: instanceId,
					cleanup,
				};
				const completionSuccess =
					completion.success && !fileChangeGuardViolation;
				if (executionId && workflowId && nodeId) {
					await workflowRunTracker.markCompleted({
						id: trackedRunId,
						success: completionSuccess,
						result: completionResult,
						error: fileChangeGuardViolation || completion.error,
					});
				}

				const published = await publishCompletionEvent({
					agentWorkflowId,
					parentExecutionId,
					success: completionSuccess,
					result: completionResult,
					error: fileChangeGuardViolation || completion.error,
				});
				if (published && executionId && workflowId && nodeId) {
					await workflowRunTracker.markEventPublished(trackedRunId);
				}
				if (artifactRef) {
					await planArtifacts.markStatus(
						artifactRef,
						completionSuccess ? "executed" : "failed",
					);
				}
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				if (executionId && workflowId && nodeId) {
					await workflowRunTracker.markCompleted({
						id: trackedRunId,
						success: false,
						error: errorMsg,
					});
				}
				const published = await publishCompletionEvent({
					agentWorkflowId,
					parentExecutionId,
					success: false,
					error: errorMsg,
				});
				if (published && executionId && workflowId && nodeId) {
					await workflowRunTracker.markEventPublished(trackedRunId);
				}
				if (artifactRef) {
					await planArtifacts.markStatus(artifactRef, "failed");
				}
			} finally {
				workspaceSessions.unbindDurableInstance(instanceId);
			}
		})();

		res.json({
			success: true,
			workflow_id: agentWorkflowId,
			dapr_instance_id: instanceId,
			cleanupWorkspace,
			...(artifactRef ? { artifactRef } : {}),
			...(workspaceRef ? { workspaceRef } : {}),
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
			datacontenttype: (body.datacontenttype as string) ?? "application/json",
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
		await workspaceSessions.destroyAll();
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
	console.log(
		`[durable-agent]   POST /api/run          — start agent workflow`,
	);
	console.log(`[durable-agent]   POST /api/plan         — generate plan`);
	console.log(`[durable-agent]   POST /api/execute-plan  — execute plan`);
	console.log(
		`[durable-agent]   POST /api/tools/:id    — direct tool execution`,
	);
	console.log(
		`[durable-agent]   POST /api/workspaces/profile — create workspace profile`,
	);
	console.log(
		`[durable-agent]   POST /api/workspaces/clone   — clone repository in workspace`,
	);
	console.log(
		`[durable-agent]   POST /api/workspaces/command — execute command in workspace`,
	);
	console.log(
		`[durable-agent]   POST /api/workspaces/file    — file operation in workspace`,
	);
	console.log(
		`[durable-agent]   POST /api/workspaces/cleanup — cleanup workspace sessions`,
	);
	console.log(
		`[durable-agent]   GET  /api/workspaces/changes/:changeSetId — fetch patch artifact`,
	);
	console.log(
		`[durable-agent]   GET  /api/workspaces/executions/:executionId/changes — list patch artifacts`,
	);
	console.log(
		`[durable-agent]   GET  /api/workspaces/executions/:executionId/patch — export combined patch`,
	);
	console.log(
		`[durable-agent]   GET  /api/workspaces/executions/:executionId/files/snapshot?path=<file> — fetch aggregated file snapshot`,
	);
	console.log(`[durable-agent]   GET  /api/health       — health check`);
	console.log(
		`[durable-agent]   GET  /api/ready        — readiness check (initialized runtime)`,
	);

	// Initialize agent eagerly at startup so the Dapr workflow runtime starts
	// immediately. This is required for crash recovery: pending workflows in
	// the Dapr event log need the runtime to be running to replay.
	try {
		await initAgent();
		console.log(
			"[durable-agent] Agent initialized at startup (workflow runtime ready for replay)",
		);
	} catch (err) {
		console.error("[durable-agent] Startup initialization failed:", err);
		if (STARTUP_INIT_REQUIRED) {
			console.error(
				"[durable-agent] Failing fast because DURABLE_REQUIRE_STARTUP_INIT=true.",
			);
			process.exit(1);
		}
		console.warn(
			`[durable-agent] Continuing without eager initialization. Retrying in background every ${STARTUP_INIT_RETRY_MS}ms.`,
		);
		scheduleStartupInitRetry();
	}
});

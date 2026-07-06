/**
 * Dynamic workflow script MCP tool (`run_workflow_script`)
 *
 * Exposes ONE tool that launches a dynamic workflow SCRIPT — the
 * Claude Code Workflow dialect (`agent()` / `parallel()` / `pipeline()` /
 * `phase()` / `log()`, plus the `budget` and `args` globals). The script is
 * re-executed by the orchestrator's `dynamic_script_workflow_v1` pump, which
 * fans out durable agent sessions and accounts a shared token budget.
 *
 * Two launch modes (exactly one required):
 *  - `workflowName` — start a SAVED workflow row via the existing internal
 *    execute endpoint (mirrors workflow-tools.ts execute_workflow).
 *  - `script` — launch an INLINE, ephemeral dynamic-script workflow via the
 *    internal execute-script endpoint.
 *
 * Recursion guard: this tool is deliberately SUPPRESSED inside sessions that a
 * script itself spawned. The BFF stamps `X-Wfb-Script-Depth` on the
 * workflow-mcp-server MCP entry for those sessions, and index.ts omits the
 * script tools at `initialize` when that header is present (see
 * suppressScriptTools). So a script cannot recursively launch more scripts
 * through this surface.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setSpanOutput } from "./observability/content.js";
import type { RegisteredTool } from "./workflow-tools.js";
import { currentGoalSessionId } from "./goal-context.js";

// Same in-cluster BFF service the other tool modules target (the MCP server is
// NOT co-located with the BFF, so localhost is wrong). The deployment does not
// set WORKFLOW_BUILDER_URL, so this default is what's actually used.
const WORKFLOW_BUILDER_URL =
	process.env.WORKFLOW_BUILDER_URL ??
	"http://workflow-builder.workflow-builder.svc.cluster.local:3000";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";

// Wait-mode polling bounds. Dynamic scripts fan out many agents and can run for
// a while, so wait=true is a bounded convenience — on timeout the last-known
// (possibly non-terminal) status is returned rather than blocking forever.
const WAIT_TIMEOUT_MS = parseInt(
	process.env.SCRIPT_WAIT_TIMEOUT_MS || "120000",
	10,
);
const WAIT_POLL_INTERVAL_MS = parseInt(
	process.env.SCRIPT_WAIT_POLL_INTERVAL_MS || "2000",
	10,
);

const TERMINAL_STATUSES = new Set(["success", "error", "cancelled", "failed"]);

/** Fetch implementation is injectable for tests; defaults to global fetch. */
export type ScriptToolsContext = {
	fetchImpl?: typeof fetch;
};

/**
 * Recursion guard decision: the BFF stamps `X-Wfb-Script-Depth` on the
 * workflow-mcp-server MCP entry for sessions a script spawned. When that header
 * is present at `initialize`, the script tool is suppressed so a running script
 * cannot launch further scripts through this surface. (Pure + exported for
 * testing; index.ts consumes it in handleMcpPost.)
 */
export function shouldSuppressScriptTools(
	headers: Record<string, string | string[] | undefined>,
): boolean {
	return headers["x-wfb-script-depth"] !== undefined;
}

function textResult(data: unknown) {
	setSpanOutput(data);
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
	};
}

function errorResult(msg: string) {
	setSpanOutput({ error: msg });
	return {
		content: [{ type: "text" as const, text: msg }],
		isError: true,
	};
}

// ── Input schema ─────────────────────────────────────────────
// Raw shape is what registerTool advertises; the refined ZodObject enforces the
// "exactly one of workflowName|script" rule (exported for unit testing).
export const runWorkflowScriptShape = {
	workflowName: z
		.string()
		.optional()
		.describe(
			"Name of a SAVED dynamic-script workflow to launch. Provide EITHER workflowName OR script, not both.",
		),
	script: z
		.string()
		.optional()
		.describe(
			"Inline dynamic workflow script source (Claude Code Workflow dialect). Provide EITHER script OR workflowName, not both.",
		),
	args: z
		.record(z.any())
		.optional()
		.describe(
			"Optional input object exposed to the script as the `args` global (and as the trigger input for saved workflows).",
		),
	budgetTotal: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Optional shared token budget for the whole run. When exhausted, in-script agent() calls throw so the script can wrap up.",
		),
	wait: z
		.boolean()
		.optional()
		.default(false)
		.describe(
			"When true, block (bounded) until the run reaches a terminal state and return its final status/output. Default false (returns immediately after start).",
		),
};

export const runWorkflowScriptSchema = z
	.object(runWorkflowScriptShape)
	.refine(
		(v) => (v.workflowName != null) !== (v.script != null),
		{
			message:
				"Provide exactly one of `workflowName` (saved workflow) or `script` (inline source).",
		},
	);

export type RunWorkflowScriptArgs = z.infer<typeof runWorkflowScriptSchema>;

// ── Internal HTTP helpers ────────────────────────────────────

function internalHeaders(): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Internal-Token": INTERNAL_API_TOKEN,
	};
	// Forward the spawning session (codex thread) for run lineage, exactly like
	// the goal tools resolve it from the AsyncLocalStorage request context.
	const sessionId = currentGoalSessionId();
	if (sessionId) headers["X-Wfb-Session-Id"] = sessionId;
	return headers;
}

/** Poll the internal execution-status route until terminal or timeout. */
async function waitForTerminal(
	fetchImpl: typeof fetch,
	executionId: string,
): Promise<{ status: string; output?: unknown; timedOut?: boolean }> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	let lastStatus = "running";
	let lastOutput: unknown = undefined;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			const resp = await fetchImpl(
				`${WORKFLOW_BUILDER_URL}/api/internal/agent/workflows/executions/${encodeURIComponent(
					executionId,
				)}/status`,
				{ headers: internalHeaders() },
			);
			if (resp.ok) {
				const body = (await resp.json()) as {
					status?: string;
					execution?: { status?: string; output?: unknown };
				};
				lastStatus = body.execution?.status ?? body.status ?? lastStatus;
				lastOutput = body.execution?.output ?? lastOutput;
				if (TERMINAL_STATUSES.has(lastStatus)) {
					return { status: lastStatus, output: lastOutput };
				}
			}
		} catch {
			// Transient — keep polling until the deadline.
		}
		if (Date.now() + WAIT_POLL_INTERVAL_MS >= deadline) {
			return { status: lastStatus, output: lastOutput, timedOut: true };
		}
		await new Promise((r) => setTimeout(r, WAIT_POLL_INTERVAL_MS));
	}
}

// ── Registration ─────────────────────────────────────────────

export function registerScriptTools(
	server: McpServer,
	ctx?: ScriptToolsContext,
): RegisteredTool[] {
	const tools: RegisteredTool[] = [];
	const fetchImpl = ctx?.fetchImpl ?? fetch;

	(server as any).registerTool(
		"run_workflow_script",
		{
			title: "Run Workflow Script",
			description:
				"Launch a DYNAMIC workflow script (Claude Code Workflow dialect: agent(), parallel() (barrier), pipeline() (streaming), phase()/log(), plus the `budget` and `args` globals) as a durable run. The orchestrator re-executes the script and FANS OUT agent sessions, each of which consumes the shared token budget. Provide EXACTLY ONE of `workflowName` (start a saved dynamic-script workflow) or `script` (inline source). Optionally pass `args` (exposed to the script) and `budgetTotal` (shared token cap). By default this returns immediately with the run identifiers; set `wait:true` to block (bounded) for the terminal status/output. NOTE: this tool is NOT available inside sessions that a script itself spawned (recursion guard) — a running agent cannot launch further scripts through it.",
			inputSchema: runWorkflowScriptShape,
		},
		async (rawArgs: unknown) => {
			const parsed = runWorkflowScriptSchema.safeParse(rawArgs);
			if (!parsed.success) {
				return errorResult(
					parsed.error.issues.map((i) => i.message).join("; "),
				);
			}
			const args = parsed.data;

			if (!INTERNAL_API_TOKEN) {
				return errorResult(
					"INTERNAL_API_TOKEN is not configured; cannot launch a workflow script.",
				);
			}

			try {
				let executionId: string;
				let instanceId: string;
				let workflowId: string;

				if (args.workflowName != null) {
					// Saved mode — reuse the existing internal execute endpoint
					// (mirrors workflow-tools.ts execute_workflow), which accepts a
					// workflowName directly and resolves it server-side.
					const resp = await fetchImpl(
						`${WORKFLOW_BUILDER_URL}/api/internal/agent/workflows/execute`,
						{
							method: "POST",
							headers: internalHeaders(),
							body: JSON.stringify({
								workflowName: args.workflowName,
								triggerData: args.args ?? {},
								budgetTotal: args.budgetTotal,
							}),
						},
					);
					if (!resp.ok) {
						const text = await resp.text();
						return errorResult(
							`Failed to start saved workflow "${args.workflowName}" (HTTP ${resp.status}): ${text}`,
						);
					}
					const result = (await resp.json()) as {
						executionId: string;
						instanceId: string;
						workflowId: string;
					};
					executionId = result.executionId;
					instanceId = result.instanceId;
					workflowId = result.workflowId;
				} else {
					// Inline mode — the BFF validates the source, upserts an ephemeral
					// private dynamic-script workflow row, and starts it.
					const resp = await fetchImpl(
						`${WORKFLOW_BUILDER_URL}/api/internal/agent/workflows/execute-script`,
						{
							method: "POST",
							headers: internalHeaders(),
							body: JSON.stringify({
								script: args.script,
								args: args.args ?? {},
								budgetTotal: args.budgetTotal,
							}),
						},
					);
					if (!resp.ok) {
						const text = await resp.text();
						return errorResult(
							`Failed to start inline workflow script (HTTP ${resp.status}): ${text}`,
						);
					}
					const result = (await resp.json()) as {
						executionId: string;
						instanceId: string;
						workflowId: string;
					};
					executionId = result.executionId;
					instanceId = result.instanceId;
					workflowId = result.workflowId;
				}

				if (args.wait) {
					const terminal = await waitForTerminal(fetchImpl, executionId);
					return textResult({
						executionId,
						instanceId,
						workflowId,
						status: terminal.status,
						...(terminal.output !== undefined
							? { output: terminal.output }
							: {}),
						...(terminal.timedOut ? { timedOut: true } : {}),
					});
				}

				return textResult({
					executionId,
					instanceId,
					workflowId,
					status: "started",
				});
			} catch (err) {
				return errorResult(`Failed to launch workflow script: ${err}`);
			}
		},
	);
	tools.push({
		name: "run_workflow_script",
		description: "Launch a dynamic workflow script (fans out agent sessions)",
	});

	return tools;
}

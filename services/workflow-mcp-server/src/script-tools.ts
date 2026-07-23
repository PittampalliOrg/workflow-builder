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
 * script itself spawned. The BFF signs script depth into the session credential,
 * and index.ts omits the script tools when that verified claim is nonzero. An
 * unsigned caller header cannot enable or suppress this surface.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  hasWorkflowMcpScope,
  type WorkflowMcpPrincipal,
  type WorkflowMcpScope,
} from "./auth-context.js";
import { setSpanOutput } from "./observability/content.js";
import type { ScriptWorkflowPersistencePort } from "./ports/workflow-persistence.js";
import type { RegisteredTool } from "./workflow-tools.js";

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
const targetInput = z
	.string()
	.optional()
	.describe(
    'Workflow runtime target. Omit or use "dev" for local execution. Preview values return direct-connect guidance because credentials are never forwarded across targets.',
	);

// Compact authoring reference for the dynamic-script (Claude Code Workflow) dialect
// AS IT BEHAVES ON THIS PLATFORM. Served verbatim by `get_workflow_script_spec` so an
// authoring agent knows the primitives AND the platform deltas that make a
// spec-authored script behave differently here. Keep in sync with
// docs/dynamic-script-authoring-guide.md (the human SSOT).
export const PLATFORM_SCRIPT_DIALECT_GUIDE = `# Dynamic Script dialect (workflow-builder platform)

Write plain JavaScript (NOT TypeScript). The script starts with a PURE-LITERAL
\`export const meta = { name, description?, phases?, input? }\` (name required; no
variables/calls inside it), then a body using these globals/hooks. The engine RE-EXECUTES
the whole script each round, so it must be deterministic.

RUN PARAMETERIZATION (meta.input + x-wfb). Anything the user may want to change per run —
ESPECIALLY which agent runs a step — must be declared as a property of \`meta.input\`
(an object JSON Schema; validated at start, rendered as the run form) and threaded through
the \`args\` global. Annotate semantic inputs with the vendor keyword \`'x-wfb'\` so the
UI renders a typed picker instead of a text box (validators ignore it):

  export const meta = {
    name: 'review',
    input: {
      type: 'object',
      properties: {
        topic:       { type: 'string', title: 'Topic' },
        reviewAgent: { type: 'string', default: 'trace-analyst', title: 'Reviewer',
                       'x-wfb': { kind: 'agent' } },          // agent picker
      },
    },
  }
  const verdict = await agent('Review ' + args.topic, { agent: args.reviewAgent })

Kinds: 'agent' (a registered agent slug — dispatch resolves it FAIL-CLOSED; add
\`runtime: '<runtime>'\` to narrow the picker), 'model', 'sandbox-template'. Always give
parameterized inputs a sensible \`default\` so the workflow runs unconfigured.

PRIMITIVES (identical to Claude Code). The script body is ASYNC — every hook returns a
Promise and MUST be awaited (\`const x = await agent(...)\`, \`const [a, b] = await
parallel([...])\`). A forgotten await is a hard script_error (the engine detects completed
scripts with un-awaited calls, Promises in the returnValue, and "[object Promise]" in prompts):
- agent(prompt, opts?) -> final text (string), or schema-validated object (with opts.schema),
  or null (skipped/died/exceeded structured-retry cap). .filter(Boolean) fanned-out results.
- parallel(thunks) -> BARRIER; runs all, a throwing thunk becomes null, never rejects.
- pipeline(items, ...stages) -> per-item, NO barrier; stage gets (prevResult, originalItem, index);
  a throwing stage drops that item to null + skips its remaining stages. DEFAULT for multi-stage.
- phase(title); log(msg)/console.log(...).
- workflow(nameOrRef, args?) -> runs another SAVED dynamic-script workflow, returns its returnValue.
  THROWS on unknown name / child error (catch to handle gracefully); user-skip resolves null.
  ONE LEVEL ONLY (nested workflow() throws). Nested children SHARE the parent's token budget.
- args -> the run's VERBATIM input: ANY JSON value (object/array/string/number/bool/null),
  deep-frozen; undefined when no input was provided (guard with args?.x / Array.isArray(args)).
- budget -> { total:number|null, spent():number, remaining():number }.
- Return a value at the end (bare top-level \`return {...}\`) — it becomes the run's output.

PLATFORM DELTAS (differ from the Claude Code spec — get these right):
1. opts.model = a platform MODEL KEY (e.g. 'kimi/kimi-k3', 'anthropic/claude-opus-4-8'), NOT a tier
   alias ('opus'/'sonnet' silently fall back to the default). Omit to inherit the run default.
   meta.phases[].model IS honored as a fallback: opts.model > meta.phases[phase].model >
   defaults.model (the last only on dapr-agent-py).
2. opts.agentType = the agent RUNTIME id (dapr-agent-py | claude-agent-py | adk-agent-py |
   browser-use-agent | claude-code-cli), NOT a Claude Code persona. Vary behavior via the prompt.
   An unresolvable agentType makes THAT call resolve to null (logged), not crash the run.
3. opts.isolation: use 'shared' to put agents on ONE shared workspace; default is per-agent isolated.
   'worktree' is a no-op here.
4. opts.effort ('low'|'medium'|'high'|'xhigh'|'max') is honored, clamped per provider:
   GLM/DeepSeek {low,medium,high}->high, {xhigh,max}->max; OpenAI low/medium/high (xhigh/max->high);
   Anthropic ignores it; Kimi K3 preserves low/high/max and defaults unsupported or unset values to max.
   It is part of the resume cache key.
5. budget.spent() counts input+output+cache_creation (net of cache reads), NOT output-only — a budget
   sized for Claude Code is reached SOONER here. Exhaustion makes unresolved agent() calls throw;
   in-flight agents still finish. Guard loops: while (budget.total && budget.remaining() > N) {...}.
6. Caps: concurrency = deployment env (dev ~5); lifetime agents default 1000, narrowed per-deploy
   (dev ~50); max 4096 items per parallel()/pipeline() call; script <= 256 KiB. Concurrency/lifetime
   caps are per workflow LEVEL (a nested tree can reach 2x the per-level concurrency).

DETERMINISM (these THROW): Date.now(), argless new Date(), Date(), Math.random(), import, require,
fetch, process, timers, eval, new Function(), WebAssembly. Pure built-ins (JSON, Math except random,
Array, Object, String, Number) are OK. log() and console.log/error/warn/info/debug all write to the
run log. Need time/randomness -> pass via args or derive from the item index.

STRUCTURED OUTPUT: pass opts.schema (JSON Schema). The engine enforces an output contract, validates,
and retries a corrective session up to 5 times; still-invalid -> the call resolves to null.

TEAM PRIMITIVES (script-led Agent Teams — THE SCRIPT IS THE LEAD; teammates are persistent
autonomous agents that claim tasks, message each other, and suspend/wake, while your script
deterministically forms the team, seeds work, and awaits quiescence):
  await team.spawn({name, agent, prompt, model?, planModeRequired?}) -> {name, sessionId}
      name <=32 chars, no '@'; agent = a PROJECT AGENT SLUG (e.g. 'team-tester-glm'); prompt must be
      SELF-CONTAINED (the teammate does not see your script). Each spawn = a real agent session.
  await team.task({title, description?, dependsOn?: [taskIds], assignTo?: name, assignMode?}) -> {ok, task}
      assignTo pre-assigns; assignMode 'direct' (default) hands it over in_progress, 'queue' RESERVES
      it (pending, claimable only by the designee, picked up before open tasks). Unassigned tasks are
      CLAIMABLE by idle teammates (dependsOn gates claimability until prerequisites complete).
  await team.send(name, content) / await team.broadcast(content)   — messages wake suspended teammates.
  await team.status() -> {team, members, tasks}                     — point-in-time snapshot.
  await team.join({until?: 'tasks-complete'|'all-idle', timeoutMinutes? (<=120, default 30)})
      -> final snapshot + {satisfied, timedOut}. RESOLVES on timeout (never throws for time) — check
      .timedOut. This is how the script waits for the team.
  await team.shutdown(name?)                                        — one teammate, or ALL when omitted.
Semantics: team.* failures (unknown agent slug, unknown teammate, project-less run) THROW into the
script (try/catch-able), like workflow(). One team per run (id team-<executionId>); teammates and their
LLM usage roll up under YOUR run + budget. TEAM TOKEN BUDGET: set meta.team = { tokenBudget: N } to
cap the team's total input+output tokens across every member session — once exhausted, team.spawn
THROWS and idle teammates stop being fed new tasks (in-flight turns finish). Omit for unlimited. Teammates cannot spawn nested teams; nested workflow()
children cannot use team.*. Auto-shutdown fires at run end, but ending with join() then shutdown() is
good practice. Each sequential await team.* costs a pump round — batch independent calls with
parallel([() => team.task({...}), () => team.task({...})]). RESULTS: instruct teammates to pass the
DELIVERABLE as update_task's note — it lands on the task row and comes back in team.status()/join()
snapshots as tasks[].note. Synthesize your run's return value from those notes (pure JS, or feed them
to a final agent() call for judgment-heavy synthesis) so the run's Outputs tab carries the deliverable.
KNOWLEDGE (the CONTENT layer, Open Knowledge Format): teammates also have publish_knowledge({path,
type, title?, description?, tags?, body}) and read_knowledge({path?|type?}) — a shared, durable
concept store (one markdown doc per path; re-publishing revises; cross-link with [t](/other/path.md)).
Use notes for the SUMMARY-sized result and knowledge for the FULL artifact: instruct teammates to
publish findings as type 'Finding' and the final work as type 'Deliverable', citing sources. The
bundle is exportable as a spec-conformant OKF directory (GET /api/v1/teams/{id}/knowledge/bundle)
and its index renders in TeamPulse.

VALIDATE THEN RUN: call validate_workflow_script(script) first; fix any error; then run_workflow_script
with { script } (inline) or { workflowName } (saved). Fixtures to pattern-match live in
scripts/fixtures/dynamic-scripts/ (best-of-n, audit-fanout, iterate-until-approved, discover-until-dry,
nested-parent + summarize-child, demo-review, team-research).`;

/** Fetch implementation is injectable for tests; defaults to global fetch. */
export type ScriptToolsContext = {
	fetchImpl?: typeof fetch;
  persistence: ScriptWorkflowPersistencePort;
  principal?: WorkflowMcpPrincipal;
};

/**
 * Recursion guard decision from the capabilities returned by the BFF after it
 * verifies the signed platform-session credential. Request headers are not
 * consulted because callers can omit or forge them.
 */
export function shouldSuppressScriptTools(capabilities?: {
  scriptDepth?: number;
}): boolean {
  return (capabilities?.scriptDepth ?? 0) > 0;
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
		.any()
		.optional()
		.describe(
			"Optional input exposed to the script as the `args` global — ANY JSON value (object, array, string, number, bool, null), passed verbatim. Omit it and the script's `args` global is undefined. For saved workflows this is also the trigger input.",
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
	target: targetInput,
};

export const runWorkflowScriptSchema = z
	.object(runWorkflowScriptShape)
  .refine((v) => (v.workflowName != null) !== (v.script != null), {
			message:
				"Provide exactly one of `workflowName` (saved workflow) or `script` (inline source).",
  });

export type RunWorkflowScriptArgs = z.infer<typeof runWorkflowScriptSchema>;

// ── Internal HTTP helpers ────────────────────────────────────

function internalHeaders(
  principal: WorkflowMcpPrincipal,
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"X-Internal-Token": INTERNAL_API_TOKEN,
    "X-Wfb-Principal-Assertion": principal.principalAssertion,
	};
  if (principal.sessionId) headers["X-Wfb-Session-Id"] = principal.sessionId;
	return headers;
}

/** Poll the internal execution-status route until terminal or timeout. */
async function waitForTerminal(
	fetchImpl: typeof fetch,
	executionId: string,
  principal: WorkflowMcpPrincipal,
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
        { headers: internalHeaders(principal) },
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

async function maybeProxyScriptTool(
  _toolName: string,
	args: Record<string, unknown>,
  _principal: WorkflowMcpPrincipal,
) {
  const target = typeof args.target === "string" ? args.target.trim() : "";
  if (!target || ["dev", "host", "local"].includes(target.toLowerCase())) {
    return null;
  }
  throw new Error(
    "Cross-target workflow calls are disabled. No source credential was forwarded; connect your MCP client directly to the intended preview endpoint with a key created for that target.",
	);
}

const SCRIPT_TOOL_SCOPES: Record<string, WorkflowMcpScope> = {
  run_workflow_script: "workflow:execute",
  validate_workflow_script: "workflow:write",
  save_workflow_script: "workflow:write",
  get_workflow_script_spec: "workflow:read",
};

function scopedToolServer(
  server: McpServer,
  principal?: WorkflowMcpPrincipal,
): McpServer {
  return {
    registerTool(name: string, ...args: unknown[]) {
      const scope = SCRIPT_TOOL_SCOPES[name];
      if (scope && hasWorkflowMcpScope(principal, scope)) {
        return (server as any).registerTool(name, ...args);
      }
      return undefined;
    },
  } as unknown as McpServer;
}

// ── Registration ─────────────────────────────────────────────

export function registerScriptTools(
	server: McpServer,
  ctx: ScriptToolsContext,
): RegisteredTool[] {
  const principal = ctx.principal;
  const toolServer = scopedToolServer(server, principal);
	const tools: RegisteredTool[] = [];
  const fetchImpl = ctx.fetchImpl ?? fetch;

  (toolServer as any).registerTool(
		"run_workflow_script",
		{
			title: "Run Workflow Script",
			description:
				"Launch a DYNAMIC workflow script (Claude Code Workflow dialect: agent(), parallel() (barrier), pipeline() (streaming), phase()/log(), plus the `budget` and `args` globals) as a durable run. The orchestrator re-executes the script and FANS OUT agent sessions, each of which consumes the shared token budget. Provide EXACTLY ONE of `workflowName` (start a saved dynamic-script workflow) or `script` (inline source). Optionally pass `args` (exposed to the script) and `budgetTotal` (shared token cap). By default this returns immediately with the run identifiers; set `wait:true` to block (bounded) for the terminal status/output. When authoring an inline `script`, FIRST call `get_workflow_script_spec` for the dialect + platform deltas (opts.model/agentType/isolation vocabulary, budget unit, caps) and `validate_workflow_script` to confirm it is syntactically correct. NOTE: this tool is NOT available inside sessions that a script itself spawned (recursion guard) — a running agent cannot launch further scripts through it.",
			inputSchema: runWorkflowScriptShape,
		},
		async (rawArgs: unknown) => {
			const parsed = runWorkflowScriptSchema.safeParse(rawArgs);
			if (!parsed.success) {
				return errorResult(
					parsed.error.issues.map((i) => i.message).join("; "),
				);
			}
      if (!principal) {
        return errorResult(
          "Workspace authentication is required. Call get_workflow_context for setup guidance.",
        );
      }
			const args = parsed.data;

			const proxied = await maybeProxyScriptTool(
				"run_workflow_script",
				args as Record<string, unknown>,
        principal,
			);
			if (proxied) return proxied;

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
          // Resolve names inside the authenticated project before calling the
          // BFF. Global latest-by-name resolution can otherwise select a
          // same-named workflow from another workspace.
          const workflow = await ctx.persistence.findWorkflow(
            args.workflowName,
            principal.projectId,
          );
          if (!workflow) {
            return errorResult(
              `Saved workflow "${args.workflowName}" was not found in the authenticated workspace.`,
            );
          }
          if (workflow.engineType !== "dynamic-script") {
            return errorResult(
              `Saved workflow "${args.workflowName}" is not a dynamic-script workflow. Use execute_workflow for non-script workflows.`,
            );
          }
					const resp = await fetchImpl(
						`${WORKFLOW_BUILDER_URL}/api/internal/agent/workflows/execute`,
						{
							method: "POST",
              headers: internalHeaders(principal),
							body: JSON.stringify({
                workflowId: workflow.id,
								// Verbatim any-JSON args; JSON.stringify drops the key when
								// undefined so the script's `args` global is undefined.
								triggerData: args.args,
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
              headers: internalHeaders(principal),
							body: JSON.stringify({
								script: args.script,
								// Verbatim any-JSON args; omitted entirely when not provided.
								args: args.args,
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
					const terminal = await waitForTerminal(
						fetchImpl,
						executionId,
            principal,
					);
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

	// ── validate_workflow_script — author-time syntactic check ──────────────
  (toolServer as any).registerTool(
		"validate_workflow_script",
		{
			title: "Validate Workflow Script",
			description:
				"Check a dynamic workflow script (Claude Code Workflow dialect) for syntactic correctness WITHOUT running it. Returns { ok, meta, estimatedAgentCalls } on success or { ok:false, error } with the reason (banned API like Date.now()/fetch/import, missing or non-literal `export const meta`, bad meta shape, size over the limit). Use this in an author→validate→fix loop before `run_workflow_script`. Call `get_workflow_script_spec` for the dialect rules + platform deltas.",
			inputSchema: {
        script: z
					.string()
          .describe("Dynamic workflow script source to validate."),
        target: targetInput,
			},
		},
		async (rawArgs: unknown) => {
			const script =
				rawArgs && typeof (rawArgs as any).script === "string"
					? (rawArgs as any).script
					: "";
			if (!script.trim()) return errorResult("script is required");
			const target =
				rawArgs && typeof (rawArgs as any).target === "string"
					? (rawArgs as any).target
					: undefined;
      if (!principal) {
        return errorResult(
          "Workspace authentication is required. Call get_workflow_context for setup guidance.",
        );
      }
      const proxied = await maybeProxyScriptTool(
        "validate_workflow_script",
        {
				script,
				...(target ? { target } : {}),
        },
        principal,
      );
			if (proxied) return proxied;
			if (!INTERNAL_API_TOKEN) {
				return errorResult(
					"INTERNAL_API_TOKEN is not configured; cannot validate a workflow script.",
				);
			}
			try {
				const resp = await fetchImpl(
					`${WORKFLOW_BUILDER_URL}/api/internal/agent/workflows/validate-script`,
					{
						method: "POST",
            headers: internalHeaders(principal),
						body: JSON.stringify({ script }),
					},
				);
        const data = (await resp.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          meta?: unknown;
          estimatedAgentCalls?: number;
        } | null;
				if (!resp.ok && (!data || typeof data.ok !== "boolean")) {
          return errorResult(`Validation request failed (HTTP ${resp.status})`);
				}
				return textResult(
					data ?? { ok: false, error: "empty validation response" },
				);
			} catch (err) {
				return errorResult(`Failed to validate workflow script: ${err}`);
			}
		},
	);
	tools.push({
		name: "validate_workflow_script",
		description: "Validate a dynamic workflow script without running it",
	});

	// ── save_workflow_script — persist a REUSABLE dynamic-script workflow ───
  (toolServer as any).registerTool(
		"save_workflow_script",
		{
			title: "Save Workflow Script",
			description:
        "Save (upsert) a dynamic workflow script as a REUSABLE named workflow WITHOUT running it — the persistence step of author → validate → save → run-by-name. The workflow is owned by the authenticated workspace principal and appears in the Workflows UI; no sessionId argument is required. An existing dynamic-script workflow with the same name in the same project is updated in place; otherwise a new one is created. Validation runs on save (a 400 carries the validator's reason — fix the script and retry). Run it later with run_workflow_script { workflowName } or your native Workflow tool.",
			inputSchema: {
				script: z.string().describe("Dynamic workflow script source to save."),
				name: z
					.string()
					.optional()
					.describe("Workflow name (defaults to the script's meta.name)."),
				target: targetInput,
			},
		},
		async (rawArgs: unknown) => {
			const script =
				rawArgs && typeof (rawArgs as any).script === "string"
					? (rawArgs as any).script
					: "";
			const name =
				rawArgs && typeof (rawArgs as any).name === "string"
					? (rawArgs as any).name
					: undefined;
			const target =
				rawArgs && typeof (rawArgs as any).target === "string"
					? (rawArgs as any).target
					: undefined;
			if (!script.trim()) return errorResult("script is required");
      if (!principal) {
        return errorResult(
          "Workspace authentication is required. Call get_workflow_context for setup guidance.",
        );
      }
      const proxied = await maybeProxyScriptTool(
        "save_workflow_script",
        {
				script,
				...(name ? { name } : {}),
				...(target ? { target } : {}),
        },
        principal,
      );
			if (proxied) return proxied;
			if (!INTERNAL_API_TOKEN) {
				return errorResult(
					"INTERNAL_API_TOKEN is not configured; cannot save a workflow script.",
				);
			}
			try {
				const resp = await fetchImpl(
					`${WORKFLOW_BUILDER_URL}/api/internal/agent/workflows/save-script`,
					{
						method: "POST",
            headers: internalHeaders(principal),
						body: JSON.stringify({ script, ...(name ? { name } : {}) }),
					},
				);
        const data = (await resp.json().catch(() => null)) as {
          workflowId?: string;
          name?: string;
          action?: string;
          error?: string;
        } | null;
				if (!resp.ok) {
					return errorResult(
						`Failed to save workflow script (HTTP ${resp.status}): ${data?.error ?? "unknown error"}`,
					);
				}
				return textResult(data);
			} catch (err) {
				return errorResult(`Failed to save workflow script: ${err}`);
			}
		},
	);
	tools.push({
		name: "save_workflow_script",
		description: "Save a dynamic workflow script as a reusable named workflow",
	});

	// ── get_workflow_script_spec — serve the dialect reference ──────────────
  (toolServer as any).registerTool(
		"get_workflow_script_spec",
		{
			title: "Get Workflow Script Spec",
			description:
				"Return the authoring reference for the dynamic workflow script dialect (Claude Code Workflow primitives + this platform's deltas: opts.model/agentType/isolation/effort vocabulary, the budget token unit, and the concurrency/lifetime/size caps). Read this BEFORE authoring an inline `script`, then use `validate_workflow_script` and `run_workflow_script`.",
			inputSchema: {},
		},
		async () => {
			return {
				content: [
					{ type: "text" as const, text: PLATFORM_SCRIPT_DIALECT_GUIDE },
				],
			};
		},
	);
	tools.push({
		name: "get_workflow_script_spec",
		description: "Authoring reference for the dynamic workflow script dialect",
	});

	return tools;
}

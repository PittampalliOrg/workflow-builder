/**
 * Evaluator-gated goal completion (Phase 1: deterministic evidence).
 *
 * The doer agent's self-declared completion is a *request* for evaluation, not
 * the completion itself. An independent evaluator runs the goal's declared
 * `evidence.commands` in the session's workspace; the goal may only be marked
 * complete when every command exits 0. If any fails, completion is rejected and
 * the failing output is returned to the agent so it keeps working.
 *
 * Opt-in: a goal WITHOUT `evidencePlan.commands` evaluates as `met:true`
 * (self-judged completion, unchanged) so existing goals are unaffected.
 *
 * See docs/goal-loop-evaluator-design.md. Phase 1 is deterministic-only (no LLM
 * critic); the function is runtime-agnostic so native-CLI/agy can call it too.
 */
import { daprFetch, getWorkspaceRuntimeUrl } from "$lib/server/dapr-client";
import { getRuntimeDescriptor } from "$lib/server/agents/runtime-registry";
import { waitForAgentWorkflowHostAppReady } from "$lib/server/sessions/agent-workflow-host";
import type {
	SessionGoalStore,
	WorkflowDataService,
} from "$lib/server/application/ports";

const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN?.trim() ?? "";

const EVIDENCE_COMMAND_TIMEOUT_MS = Number(
	process.env.GOAL_EVIDENCE_COMMAND_TIMEOUT_MS || 180_000,
);
const MAX_OUTPUT_CHARS = 1500;

export type CriterionResult = {
	command: string;
	exitCode: number;
	ok: boolean;
	output: string;
};

export type GoalEvaluation = {
	met: boolean;
	/** true when the goal declared no evidence — self-judged completion path. */
	skipped: boolean;
	results: CriterionResult[];
	/** Human/agent-readable verdict; on rejection, the failing command output. */
	feedback: string;
};

// The agent's working filesystem depends on the runtime:
//  - openshell  (dapr-agent-py + workspace/profile): the agent's tools execute
//    in the retained openshell workspace sandbox (workflow_workspace_sessions),
//    reached via openshell-agent-runtime /api/workspaces/command.
//  - cli-direct (interactive-cli: codex/claude/agy): the vendor CLI writes to
//    its OWN pod-local /sandbox (it ignores workspaceRef), so evidence must run
//    in the CLI pod directly via cli-agent-py /internal/workspace/command at
//    pod-IP:8002. Targeting the (empty) openshell workspace would falsely fail.
type EvidenceTarget =
	| {
			kind: "openshell";
			executionId: string;
			workspaceRef: string | null;
			rootPath: string;
	  }
	| { kind: "cli-direct"; baseUrl: string; rootPath: string };

export type GoalCompletionEvaluatorDependencies = {
	goals: Pick<SessionGoalStore, "getCurrentGoal">;
	workflowData: Pick<
		WorkflowDataService,
		| "getSessionDetail"
		| "getSessionRuntimeDebugTarget"
		| "listWorkflowWorkspaceSessionsByExecutionId"
	>;
	waitForAgentWorkflowHostAppReady?: typeof waitForAgentWorkflowHostAppReady;
	runEvidenceCommand?: (
		target: EvidenceTarget,
		command: string,
	) => Promise<CriterionResult>;
};

/** Resolve where evidence commands must run for this session. Interactive-CLI
 *  agents run in their own pod's /sandbox (reach the pod directly); everything
 *  else uses the retained openshell workspace (the same source the live-preview
 *  proxy uses: workflow_workspace_sessions keyed on the parent execution). */
async function resolveEvidenceTarget(
	deps: GoalCompletionEvaluatorDependencies,
	sessionId: string,
	workflowExecutionId: string | null,
): Promise<EvidenceTarget | null> {
	// Interactive-CLI: the agent writes to the CLI pod's local /sandbox.
	const rt = await deps.workflowData.getSessionRuntimeDebugTarget({ sessionId });
	if (getRuntimeDescriptor(rt?.agentRuntime)?.family === "interactive-cli") {
		if (!rt?.appId) return null;
		try {
			const waitForHost =
				deps.waitForAgentWorkflowHostAppReady ??
				waitForAgentWorkflowHostAppReady;
			const { baseUrl } = await waitForHost({
				agentAppId: rt.appId,
			});
			if (!baseUrl) return null;
			return { kind: "cli-direct", baseUrl, rootPath: "/sandbox" };
		} catch {
			return null;
		}
	}

	// Non-CLI (dapr): the agent's tools execute in an openshell workspace sandbox.
	// Workflow-driven: the retained workspace/profile sandbox (the same source the
	// live-preview proxy uses: workflow_workspace_sessions keyed on the execution).
	if (workflowExecutionId) {
		const rows =
			await deps.workflowData.listWorkflowWorkspaceSessionsByExecutionId({
				executionId: workflowExecutionId,
				limit: 1,
			});
		const row = rows[0];
		if (row?.workspaceRef) {
			return {
				kind: "openshell",
				executionId: workflowExecutionId,
				workspaceRef: row.workspaceRef,
				rootPath:
					(typeof row.rootPath === "string" && row.rootPath.trim()) || "/sandbox",
			};
		}
	}
	// Direct (one-off, non-workflow) dapr session: fall back to the session's own
	// bound sandbox so evidence verifies for one-off goals too.
	const session = await deps.workflowData.getSessionDetail({ sessionId });
	const sandboxRef =
		session?.workspaceSandboxName?.trim() || session?.sandboxName?.trim() || null;
	if (!sandboxRef) return null;
	return {
		kind: "openshell",
		executionId: sessionId,
		workspaceRef: sandboxRef,
		rootPath: "/sandbox",
	};
}

async function runEvidenceCommand(
	target: EvidenceTarget,
	command: string,
): Promise<CriterionResult> {
	try {
		if (target.kind === "cli-direct") {
			// cli-agent-py runs `bash -lc` in the pod-local /sandbox and returns
			// { ok, exit_code, stdout_tail, stderr_tail }.
			const res = await daprFetch(`${target.baseUrl}/internal/workspace/command`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(INTERNAL_API_TOKEN ? { "X-Internal-Token": INTERNAL_API_TOKEN } : {}),
				},
				body: JSON.stringify({ command, cwd: target.rootPath }),
				maxRetries: 0,
			});
			if (!res.ok) {
				const detail = (await res.text().catch(() => "")).slice(0, MAX_OUTPUT_CHARS);
				return { command, exitCode: -1, ok: false, output: `cli runtime error ${res.status}: ${detail}` };
			}
			const raw = (await res.json().catch(() => ({}))) as {
				exit_code?: number | null;
				stdout_tail?: string;
				stderr_tail?: string;
			};
			const exitCode = typeof raw.exit_code === "number" ? raw.exit_code : 1;
			const output = `${raw.stderr_tail ?? ""}${raw.stderr_tail && raw.stdout_tail ? "\n" : ""}${raw.stdout_tail ?? ""}`.trim();
			return { command, exitCode, ok: exitCode === 0, output: output.slice(0, MAX_OUTPUT_CHARS) };
		}

		const res = await daprFetch(`${getWorkspaceRuntimeUrl()}/api/workspaces/command`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				executionId: target.executionId,
				workspaceRef: target.workspaceRef ?? undefined,
				command,
				cwd: target.rootPath,
				timeoutMs: EVIDENCE_COMMAND_TIMEOUT_MS,
				// non-zero exit is data here, not a transport failure
				allowFailure: true,
				workflowId: "goal-evaluator",
				nodeId: target.executionId,
				nodeName: "evaluate-evidence",
			}),
			maxRetries: 0,
		});
		if (!res.ok) {
			const detail = (await res.text().catch(() => "")).slice(0, MAX_OUTPUT_CHARS);
			return { command, exitCode: -1, ok: false, output: `runtime error ${res.status}: ${detail}` };
		}
		// The workspace runtime nests the command result under `result`:
		//   { success, result: { exitCode, stdout, stderr, ... } }
		// Fall back to top-level fields in case a runtime returns them flat.
		const raw = (await res.json().catch(() => ({}))) as {
			result?: { exitCode?: number; stdout?: string; stderr?: string };
			exitCode?: number;
			stdout?: string;
			stderr?: string;
		};
		const r = raw.result ?? raw;
		const exitCode = typeof r.exitCode === "number" ? r.exitCode : 1;
		const output = `${r.stderr ?? ""}${r.stderr && r.stdout ? "\n" : ""}${r.stdout ?? ""}`.trim();
		return { command, exitCode, ok: exitCode === 0, output: output.slice(0, MAX_OUTPUT_CHARS) };
	} catch (err) {
		return {
			command,
			exitCode: -1,
			ok: false,
			output: `evidence command errored: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

/**
 * Evaluate whether a goal genuinely meets its acceptance criteria by running its
 * declared evidence commands in the session workspace. Deterministic-only.
 */
export class GoalCompletionEvaluator {
	constructor(private readonly deps: GoalCompletionEvaluatorDependencies) {}

	async evaluateGoalCompletion(sessionId: string): Promise<GoalEvaluation> {
		const goal = await this.deps.goals.getCurrentGoal(sessionId);
		if (!goal) {
			return {
				met: false,
				skipped: false,
				results: [],
				feedback: "No goal found for this session.",
			};
		}
		const commands = goal.evidencePlan?.commands ?? [];
		if (!commands.length) {
			// No declared evidence → self-judged completion (unchanged behavior).
			return {
				met: true,
				skipped: true,
				results: [],
				feedback:
					"No evidence commands declared; accepting self-judged completion.",
			};
		}
		const target = await resolveEvidenceTarget(
			this.deps,
			sessionId,
			goal.workflowExecutionId,
		);
		if (!target) {
			// Can't verify → do NOT auto-pass; reject so completion isn't granted blind.
			return {
				met: false,
				skipped: false,
				results: [],
				feedback:
					"Evaluator could not reach the session workspace to run the evidence commands. The goal cannot be confirmed complete.",
			};
		}

		const runner = this.deps.runEvidenceCommand ?? runEvidenceCommand;
		const results: CriterionResult[] = [];
		for (const command of commands) {
			results.push(await runner(target, command));
		}
		const failures = results.filter((r) => !r.ok);
		const met = failures.length === 0;
		// IMPORTANT: the agent-facing feedback shows each failing check's OUTPUT only,
		// NOT the command text. Echoing the command would let the doer read (and
		// hardcode against) the evaluator's checks — defeating the evaluator-gated
		// premise — and would reveal all hidden/incremental requirements at once. The
		// command is still kept in `results[]` for the human-facing Goal view grid.
		const feedback = met
			? `All ${results.length} evidence check(s) passed.`
			: [
					`Completion rejected — ${failures.length}/${results.length} acceptance check(s) failed.`,
					...failures.map(
						(f) =>
							`\nCheck ${results.indexOf(f) + 1} of ${results.length} [exit ${f.exitCode}]:\n${f.output || "(no output)"}`,
					),
					"\nFix the issues shown above and continue working before marking the goal complete.",
				].join("\n");
		return { met, skipped: false, results, feedback };
	}
}

let defaultEvaluator: GoalCompletionEvaluator | null = null;

async function getDefaultEvaluator(): Promise<GoalCompletionEvaluator> {
	if (defaultEvaluator) return defaultEvaluator;
	const { getApplicationAdapters } = await import("$lib/server/application");
	const adapters = getApplicationAdapters();
	defaultEvaluator = new GoalCompletionEvaluator({
		goals: adapters.sessionGoalStore,
		workflowData: adapters.workflowData,
	});
	return defaultEvaluator;
}

export async function evaluateGoalCompletion(
	sessionId: string,
	deps?: GoalCompletionEvaluatorDependencies,
): Promise<GoalEvaluation> {
	const evaluator = deps
		? new GoalCompletionEvaluator(deps)
		: await getDefaultEvaluator();
	return evaluator.evaluateGoalCompletion(sessionId);
}

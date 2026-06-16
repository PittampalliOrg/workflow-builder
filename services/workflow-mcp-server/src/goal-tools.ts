/**
 * Goal MCP tools (Codex `/goal` parity)
 *
 * create_goal / update_goal / get_goal — the runtime-agnostic completion
 * contract for the goal loop. Any MCP-capable agent runtime (dapr-agent-py,
 * claude-agent-py, ...) gets these by having the goal MCP server wired into
 * agentConfig.mcpServers. The session is resolved from the AsyncLocalStorage
 * goal context (X-Wfb-Session-Id header), never from a tool argument.
 *
 * These tools only persist the goal row; the autonomous continuation loop runs
 * in the BFF (it re-injects the continuation turn on each idle and accounts the
 * token budget). update_goal(complete) is the agent's self-judged completion
 * after the completion audit — mirroring codex.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setSpanOutput } from "./observability/content.js";
import type { RegisteredTool } from "./workflow-tools.js";
import { currentGoalSessionId } from "./goal-context.js";
import {
	completeGoalForSession,
	createOrReplaceGoalForSession,
	getGoalForSession,
	type ThreadGoalRecord,
} from "./goal-db.js";

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

function shapeGoal(goal: ThreadGoalRecord) {
	const remaining =
		goal.token_budget === null
			? null
			: Math.max(0, goal.token_budget - goal.tokens_used);
	return {
		goalId: goal.goal_id,
		objective: goal.objective,
		status: goal.status,
		tokenBudget: goal.token_budget,
		tokensUsed: goal.tokens_used,
		remainingTokens: remaining,
		timeUsedSeconds: goal.time_used_seconds,
		iterations: goal.iterations,
		maxIterations: goal.max_iterations,
	};
}

export function registerGoalTools(server: McpServer): RegisteredTool[] {
	const tools: RegisteredTool[] = [];

	// ── create_goal ─────────────────────────────────────────
	(server as any).registerTool(
		"create_goal",
		{
			title: "Create Goal",
			description:
				"Set a persistent objective for this session. The system then autonomously continues working toward it across turns (re-injecting the objective whenever you finish a turn) until you call update_goal with status \"complete\" after a completion audit, or an optional token budget is exhausted. State the objective as concrete deliverables / success criteria. Create a goal ONLY when no goal exists yet and it's explicitly requested by the user or system — do not infer a goal from an ordinary task. If a goal already exists, this fails: use update_goal (when it's genuinely complete) or get_goal; replacing an existing goal is controlled by the user or system, not by you.",
			inputSchema: {
				objective: z
					.string()
					.describe(
						"The goal to pursue, stated as concrete deliverables or success criteria.",
					),
				token_budget: z
					.number()
					.int()
					.positive()
					.optional()
					.describe(
						"Optional soft cap on total tokens. When exceeded the goal is marked budget_limited and you should wrap up.",
					),
				max_iterations: z
					.number()
					.int()
					.positive()
					.optional()
					.describe("Optional cap on continuation turns (default 50)."),
			},
		},
		async (args: {
			objective: string;
			token_budget?: number;
			max_iterations?: number;
		}) => {
			const sessionId = currentGoalSessionId();
			if (!sessionId) {
				return errorResult(
					"No session context: create_goal requires the X-Wfb-Session-Id header (set by the platform).",
				);
			}
			try {
				// Codex parity: the model cannot create (and thereby REPLACE) a goal
				// when a drivable one already exists — otherwise it can clobber a
				// user-set or workflow-preset goal's objective/budget/iterations and
				// reset usage accounting. Replacing a goal is a user/system action
				// (the Goal card / `/goal` command / workflow bridge). A completed or
				// paused goal is not drivable, so creating a fresh one (re-arm) is OK.
				const existing = await getGoalForSession(sessionId);
				if (
					existing &&
					(existing.status === "active" || existing.status === "budget_limited")
				) {
					return errorResult(
						"cannot create a new goal because this session already has an active goal; use update_goal only when the existing goal is genuinely complete (use get_goal to inspect it). Replacing a goal is controlled by the user or system.",
					);
				}
				const goal = await createOrReplaceGoalForSession({
					sessionId,
					objective: args.objective,
					tokenBudget: args.token_budget ?? null,
					maxIterations: args.max_iterations,
				});
				return textResult({ ok: true, goal: shapeGoal(goal) });
			} catch (err) {
				return errorResult(`Failed to create goal: ${err}`);
			}
		},
	);
	tools.push({ name: "create_goal", description: "Set a persistent session goal" });

	// ── update_goal ─────────────────────────────────────────
	(server as any).registerTool(
		"update_goal",
		{
			title: "Update Goal",
			description:
				"Mark the active goal complete. Call this ONLY after a completion audit shows the objective is genuinely achieved with concrete evidence — never merely because effort was spent, progress was made, or the budget is nearly exhausted. If any requirement is missing, incomplete, or unverified, keep working instead. status must be \"complete\".",
			inputSchema: {
				status: z
					.string()
					.describe('Must be "complete" — the only model-settable status.'),
			},
		},
		async (args: { status: string }) => {
			const sessionId = currentGoalSessionId();
			if (!sessionId) {
				return errorResult(
					"No session context: update_goal requires the X-Wfb-Session-Id header (set by the platform).",
				);
			}
			if (args.status !== "complete") {
				return errorResult(
					"update_goal can only mark the existing goal complete; pause, resume, and budget-limited status changes are controlled by the user or system.",
				);
			}
			try {
				const goal = await completeGoalForSession(sessionId);
				if (!goal) {
					return errorResult("No active goal to complete for this session.");
				}
				return textResult({
					ok: true,
					goal: shapeGoal(goal),
					completion_budget_report: `Goal achieved. Tokens used: ${goal.tokens_used}${
						goal.token_budget !== null ? ` / ${goal.token_budget}` : ""
					}; elapsed: ${goal.time_used_seconds}s. Report the final elapsed time (and consumed token budget, if set) to the user.`,
				});
			} catch (err) {
				return errorResult(`Failed to update goal: ${err}`);
			}
		},
	);
	tools.push({ name: "update_goal", description: "Mark the active goal complete" });

	// ── get_goal ────────────────────────────────────────────
	(server as any).registerTool(
		"get_goal",
		{
			title: "Get Goal",
			description:
				"Get the current goal for this session: objective, status, tokens used / budget / remaining, elapsed time, and iteration count.",
			inputSchema: {},
		},
		async () => {
			const sessionId = currentGoalSessionId();
			if (!sessionId) {
				return errorResult(
					"No session context: get_goal requires the X-Wfb-Session-Id header (set by the platform).",
				);
			}
			try {
				const goal = await getGoalForSession(sessionId);
				return textResult({ goal: goal ? shapeGoal(goal) : null });
			} catch (err) {
				return errorResult(`Failed to get goal: ${err}`);
			}
		},
	);
	tools.push({ name: "get_goal", description: "Get the current session goal" });

	return tools;
}

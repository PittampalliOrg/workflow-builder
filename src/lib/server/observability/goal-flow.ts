/**
 * Assemble the GOAL-EVALUATOR flow for the trace viewer.
 *
 * The evaluator emits no OTEL spans — the flow lives in Postgres
 * (`thread_goals` + `session_events`). We segment the persisted event stream
 * into ATTEMPTS, each ending in an evaluator VERDICT (pass | reject), so the UI
 * can render: agent work → submit → evaluate → verdict → loop → complete.
 *
 * Uses persisted data only (never re-runs the evaluator). PASS verdicts persist
 * no per-command results (only `session.goal_completed`); only REJECT carries
 * `results[]`, so PASS shows a verified count, never fabricated check rows.
 */
import {
	getCurrentGoalForSessions,
	listGoalFlowEvents,
	type GoalFlowEventRow,
} from '$lib/server/goals/repo';
import type {
	GoalFlow,
	GoalFlowAttempt,
	GoalFlowCheck,
	GoalFlowStatus,
	ObservabilityAgentDecisionTurn,
} from '$lib/types/observability';

const GOAL_MCP_TOOLS = new Set(['wfb_goal_update_goal', 'wfb_goal_get_goal']);

function str(v: unknown): string | null {
	return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** llm_usage delta (codex semantics: input + output + cache_creation, cache reads excluded). */
function usageDelta(data: Record<string, unknown>): number {
	const total = num(data.total_tokens);
	if (total > 0) return total;
	return (
		num(data.input_tokens) + num(data.output_tokens) + num(data.cache_creation_input_tokens)
	);
}

function eventToolName(ev: GoalFlowEventRow): string | null {
	const d = ev.data ?? {};
	return str(d.name) ?? str((d.tool as Record<string, unknown> | undefined)?.name) ?? null;
}

function mapChecks(results: unknown): GoalFlowCheck[] {
	if (!Array.isArray(results)) return [];
	return results.map((r) => {
		const o = (r ?? {}) as Record<string, unknown>;
		return {
			command: str(o.command) ?? '',
			exitCode: num(o.exitCode),
			ok: o.ok === true,
			output: str(o.output) ?? '',
		};
	});
}

interface Accum {
	iteration: number;
	startedAt: string | null;
	turnCount: number;
	toolNames: Set<string>;
	toolCallCount: number;
	tokenDelta: number;
	submissionKind: 'update_goal' | 'idle_backstop' | 'none';
	submissionAt: string | null;
	sawEndTurnIdle: boolean;
}

function freshAccum(iteration: number, startedAt: string | null): Accum {
	return {
		iteration,
		startedAt,
		turnCount: 0,
		toolNames: new Set(),
		toolCallCount: 0,
		tokenDelta: 0,
		submissionKind: 'none',
		submissionAt: null,
		sawEndTurnIdle: false,
	};
}

/**
 * Build the goal flow for whichever candidate session carries a goal.
 * Returns null when no goal exists on any owner session.
 */
export async function buildGoalFlow(
	sessionIds: string[],
	agentDecisions: ObservabilityAgentDecisionTurn[] = [],
): Promise<GoalFlow | null> {
	const goal = await getCurrentGoalForSessions(sessionIds);
	if (!goal) return null;

	const events = await listGoalFlowEvents(goal.sessionId);
	const evidenceCommands = goal.evidencePlan?.commands ?? [];
	const startedAt = goal.createdAt ? new Date(goal.createdAt).toISOString() : null;

	// Reject signal: prefer the structured `session.goal_rejected` event; only
	// fall back to the injected `goal-evidence-reject` user.message when no
	// structured event exists (avoids double-counting the paired emission).
	const hasGoalRejected = events.some((e) => e.type === 'session.goal_rejected');
	const isRejectSignal = (e: GoalFlowEventRow): boolean => {
		if (e.type === 'session.goal_rejected') return true;
		if (!hasGoalRejected && e.type === 'user.message' && str(e.data.origin) === 'goal-evidence-reject')
			return true;
		return false;
	};

	const attempts: GoalFlowAttempt[] = [];
	let cur = freshAccum(0, startedAt);
	let terminal = false;

	const closeAttempt = (
		verdict: GoalFlowAttempt['verdict'],
		endedAt: string | null,
	) => {
		attempts.push({
			id: `goal-attempt:${attempts.length}`,
			iteration: cur.iteration,
			startedAt: cur.startedAt,
			endedAt,
			work: {
				turnCount: cur.turnCount,
				toolNames: [...cur.toolNames],
				toolCallCount: cur.toolCallCount,
				tokenDelta: cur.tokenDelta || null,
			},
			submission: { kind: cur.submissionKind, at: cur.submissionAt },
			verdict,
			relatedTurnIds: [],
			relatedSpanIds: [],
		});
	};

	for (const ev of events) {
		const at = ev.createdAt ? new Date(ev.createdAt).toISOString() : null;

		if (isRejectSignal(ev)) {
			const checks = ev.type === 'session.goal_rejected' ? mapChecks(ev.data.results) : [];
			closeAttempt(
				{
					kind: 'reject',
					source: ev.type === 'session.goal_rejected' ? 'goal_rejected' : 'update_goal',
					at,
					feedback: str(ev.data.feedback) ?? extractRejectFeedback(ev),
					checks,
					failingCount: checks.length ? checks.filter((c) => !c.ok).length : 0,
					verifiedCount: null,
				},
				at,
			);
			cur = freshAccum(num(ev.data.iteration) || cur.iteration + 1, at);
			continue;
		}

		if (ev.type === 'session.goal_completed') {
			closeAttempt(
				{
					kind: 'pass',
					source: 'goal_completed',
					at,
					feedback: str(ev.data.completionSource)
						? `completed (${str(ev.data.completionSource)})`
						: null,
					checks: [],
					failingCount: 0,
					verifiedCount: evidenceCommands.length || null,
				},
				at,
			);
			terminal = true;
			break; // goal is complete — ignore any trailing/termination events
		}

		// --- work / submission accumulation ---
		if (!cur.startedAt) cur.startedAt = at;
		if (ev.type === 'agent.message') cur.turnCount += 1;
		else if (ev.type === 'agent.llm_usage') cur.tokenDelta += usageDelta(ev.data);
		else if (ev.type === 'session.status_idle') {
			const reason = (ev.data.stop_reason as Record<string, unknown> | undefined)?.type;
			if (reason === 'end_turn') cur.sawEndTurnIdle = true;
		} else if (ev.type === 'agent.tool_use' || ev.type === 'mcp.tool_call') {
			const name = eventToolName(ev);
			if (name && GOAL_MCP_TOOLS.has(name)) {
				if (name === 'wfb_goal_update_goal') {
					cur.submissionKind = 'update_goal';
					cur.submissionAt = at;
				}
			} else {
				cur.toolCallCount += 1;
				if (name) cur.toolNames.add(name);
			}
		}
	}

	// Trailing open attempt (in-progress / budget_limited / paused goals): only
	// emit it if it actually saw activity, with an inferred submission.
	const hasTrailingWork =
		cur.turnCount > 0 || cur.toolCallCount > 0 || cur.tokenDelta > 0 || cur.submissionKind !== 'none';
	if (!terminal && hasTrailingWork) {
		if (cur.submissionKind === 'none' && cur.sawEndTurnIdle) cur.submissionKind = 'idle_backstop';
		closeAttempt(
			{ kind: 'none', source: null, at: null, feedback: null, checks: [], failingCount: 0, verifiedCount: null },
			null,
		);
	}

	attachSpanLinks(attempts, agentDecisions);

	const status = goal.status as GoalFlowStatus;
	const evidenceVerified = status === 'complete' && evidenceCommands.length > 0;
	const completionSource =
		events.find((e) => e.type === 'session.goal_completed')?.data?.completionSource;

	return {
		sessionId: goal.sessionId,
		goalId: goal.goalId,
		objective: goal.objective,
		acceptanceCriteria: goal.acceptanceCriteria ?? [],
		evidenceCommands,
		status,
		iterations: goal.iterations,
		maxIterations: goal.maxIterations,
		tokensUsed: goal.tokensUsed,
		tokenBudget: goal.tokenBudget,
		stopReason: goal.stopReason,
		completionSource: str(completionSource),
		startedAt,
		completedAt: goal.completedAt ? new Date(goal.completedAt).toISOString() : null,
		attempts,
		outcome: buildOutcome(status, goal.stopReason, attempts, {
			evidenceVerified,
			tokensUsed: goal.tokensUsed,
			tokenBudget: goal.tokenBudget,
			iterations: goal.iterations,
			maxIterations: goal.maxIterations,
			evidenceCount: evidenceCommands.length,
		}),
	};
}

function extractRejectFeedback(ev: GoalFlowEventRow): string | null {
	// goal-evidence-reject user.message: text lives in content[0].text
	const content = ev.data.content;
	if (Array.isArray(content)) {
		const text = content
			.map((c) => str((c as Record<string, unknown>)?.text))
			.filter(Boolean)
			.join('\n');
		return text || null;
	}
	return null;
}

function buildOutcome(
	status: GoalFlowStatus,
	stopReason: string | null,
	attempts: GoalFlowAttempt[],
	ctx: {
		evidenceVerified: boolean;
		tokensUsed: number;
		tokenBudget: number | null;
		iterations: number;
		maxIterations: number;
		evidenceCount: number;
	},
): GoalFlow['outcome'] {
	const attemptCount = attempts.length;
	const attemptWord = `${attemptCount} attempt${attemptCount === 1 ? '' : 's'}`;
	if (status === 'complete') {
		const how = ctx.evidenceCount > 0 ? 'evidence-verified' : 'self-judged';
		return {
			verdict: 'pass',
			label: `Complete · ${attemptWord} · ${how}`,
			evidenceVerified: ctx.evidenceVerified,
			attemptCount,
		};
	}
	if (status === 'budget_limited') {
		const label =
			stopReason === 'iteration_cap'
				? `Iteration cap · ${ctx.iterations}/${ctx.maxIterations}`
				: `Budget limited · ${ctx.tokensUsed}${ctx.tokenBudget ? `/${ctx.tokenBudget}` : ''} tok`;
		return { verdict: 'none', label, evidenceVerified: false, attemptCount };
	}
	if (status === 'paused') {
		return { verdict: 'none', label: 'Paused', evidenceVerified: false, attemptCount };
	}
	return {
		verdict: 'none',
		label: `In progress · iteration ${ctx.iterations}/${ctx.maxIterations}`,
		evidenceVerified: false,
		attemptCount,
	};
}

/** Best-effort: link each attempt to the turns/spans that fall in its window. */
function attachSpanLinks(
	attempts: GoalFlowAttempt[],
	agentDecisions: ObservabilityAgentDecisionTurn[],
): void {
	if (agentDecisions.length === 0) return;
	for (let i = 0; i < attempts.length; i++) {
		const a = attempts[i];
		const start = a.startedAt ? Date.parse(a.startedAt) : -Infinity;
		const end = a.endedAt ? Date.parse(a.endedAt) : Infinity;
		const turns = agentDecisions.filter((d) => {
			const t = d.startedAt ? Date.parse(d.startedAt) : NaN;
			return Number.isFinite(t) && t >= start && t < end;
		});
		a.relatedTurnIds = turns.map((d) => d.id);
		a.relatedSpanIds = [
			...new Set(
				turns.flatMap((d) => [d.evidence?.spanId, ...(d.evidence?.toolSpanIds ?? [])].filter(Boolean) as string[]),
			),
		];
	}
}

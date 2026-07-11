/**
 * Agent Teams — token-budget gate (Codex `RolloutBudget` parity).
 *
 * `teams.token_budget` caps the WHOLE team's consumption: the sum of
 * agent.llm_usage input+output tokens across every member session (lead
 * included). Enforcement points:
 *   • teammate spawn (spawn + revive routes) — refuse growth once exhausted;
 *   • driver claim-nudges — stop feeding new work to an exhausted team
 *     (in-flight turns finish; the budget is a brake, not a kill switch).
 *
 * Budget is set at team creation: ensure-script-team accepts `tokenBudget`,
 * and TEAM_DEFAULT_TOKEN_BUDGET applies fleet-wide when the input omits it.
 * Null budget = unlimited (the default).
 */

import { getApplicationAdapters } from "$lib/server/application";
import type { TeamStore } from "$lib/server/application/ports";

export type TeamBudget = {
	/** Configured cap, null = unlimited. */
	budget: number | null;
	/** input+output tokens consumed so far across all member sessions. */
	used: number;
	/** max(0, budget - used); null when unlimited. */
	remaining: number | null;
	exhausted: boolean;
};

/** Fleet default applied when a team is created without an explicit budget. */
export function defaultTeamTokenBudget(): number | null {
	const raw = Number(process.env.TEAM_DEFAULT_TOKEN_BUDGET ?? "");
	return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : null;
}

export async function getTeamBudget(
	teamId: string,
	s: TeamStore = getApplicationAdapters().teamStore,
): Promise<TeamBudget> {
	const team = await s.getTeam(teamId);
	const budget =
		team && team.token_budget != null && Number(team.token_budget) > 0
			? Number(team.token_budget)
			: null;
	if (budget === null) {
		return { budget: null, used: 0, remaining: null, exhausted: false };
	}
	const used = await s.getTeamTokensUsed(teamId);
	return {
		budget,
		used,
		remaining: Math.max(0, budget - used),
		exhausted: used >= budget,
	};
}

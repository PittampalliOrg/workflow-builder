/**
 * Agent Teams — "team run" as a first-class workflow execution.
 *
 * A team run is a CONTAINER execution: unlike a dynamic-script run there is no
 * central Dapr workflow driving it (teammates are independent session_workflows),
 * so this execution is a passive rollup whose children are the teammate sessions
 * and whose status is COMPUTED from team_members + team_tasks. Creating it (and
 * stamping each session's workflow_execution_id) makes a team show up as ONE
 * unified run in the Fleet/runs list and gives it the run-detail cockpit
 * (rendered by the team-run engine branch → TeamRunPanel). Mirrors how the
 * dynamic-script run unifies many sessions under one execution.
 *
 * This module is orchestration only: the raw persistence lives behind the
 * `TeamStore` port (adapter), and the container execution row is created through
 * the `workflowExecutions` port — no direct db/drizzle here.
 */

import { getApplicationAdapters } from "$lib/server/application";
import type { TeamStore } from "$lib/server/application/ports";

const store = () => getApplicationAdapters().teamStore;

/**
 * Ensure the team has a container execution; create it on first call. Also sets
 * teams.workflow_execution_id and stamps the lead session. Idempotent — returns
 * the existing execution id if the team already has one.
 */
export async function ensureTeamRunExecution(
	input: {
		teamId: string;
		projectId: string;
		leadSessionId: string;
		name?: string;
		prompt?: string;
	},
	s: TeamStore = store(),
): Promise<string> {
	const existing = await s.getTeamExecutionId(input.teamId);
	if (existing) return existing;

	// ADOPTION: a lead that already belongs to an execution (a dynamic-script
	// run's anchor lead, or any session spawned under a run) makes THAT run the
	// team's container — teammates roll up under it and no synthetic execution
	// is created. The synthetic "Agent Team Runs" workflow below is only for
	// free-standing interactive leads.
	const leadExecution = await s.getSessionExecutionId(input.leadSessionId);
	if (leadExecution) {
		await s.setTeamExecutionId(input.teamId, leadExecution);
		return leadExecution;
	}

	// The run owner is the lead session's user.
	const userId = await s.getSessionUserId(input.leadSessionId);
	if (!userId) throw new Error(`lead session ${input.leadSessionId} has no user`);

	const workflowId = await s.ensureTeamRunWorkflow(input.projectId, userId);
	const { id } = await getApplicationAdapters().workflowExecutions.create({
		workflowId,
		userId,
		projectId: input.projectId,
		status: "running",
		phase: "running",
		progress: 0,
		executionIr: {
			engine: "team-run",
			teamId: input.teamId,
			leadSessionId: input.leadSessionId,
			meta: {
				name: input.name ? `Team: ${input.name}` : "Agent Team Run",
				description: input.prompt ?? null,
			},
		},
		executionIrVersion: "team-run-1",
	});

	await s.setTeamExecutionId(input.teamId, id);
	await s.stampLeadSessionExecution(input.leadSessionId, id);
	return id;
}

/** Stamp a teammate session with the team-run execution so it rolls up. */
export function linkSessionToTeamRun(
	sessionId: string,
	executionId: string,
	s: TeamStore = store(),
): Promise<void> {
	return s.linkSessionToExecution(sessionId, executionId);
}

/**
 * Recompute the container execution's status from team state and persist it, so
 * the Fleet/runs list reflects the team live. Called by the team-driver on
 * member/task changes. No-op for teams without an execution row.
 */
export function refreshTeamRunStatus(
	teamId: string,
	s: TeamStore = store(),
): Promise<void> {
	return s.refreshTeamRunStatus(teamId);
}

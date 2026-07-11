/**
 * Agent Teams — shared task list (Phase 1).
 *
 * Thin domain facade over the `TeamStore` port. The atomic claim
 * (`FOR UPDATE SKIP LOCKED`) — the single source of truth that both selects AND
 * mutates so it is race-safe without app-level locking — lives in the adapter
 * (`PostgresTeamStore`). These wrappers forward to
 * `getApplicationAdapters().teamStore`; each takes an optional `store` so the
 * unit tests can inject a PGlite-backed adapter (see team-tasks.test.ts).
 *
 * The MCP `claim_task` tool reaches the claim through the BFF internal endpoint
 * (POST /api/internal/team/[teamId]/claim), which calls `claimNextTask` here.
 */

import { getApplicationAdapters } from "$lib/server/application";
import type {
	CreateTeamTaskInput,
	TeamStore,
	TeamTaskRow,
} from "$lib/server/application/ports";

export type { TeamTaskRow } from "$lib/server/application/ports";

const store = () => getApplicationAdapters().teamStore;

export function createTask(
	input: CreateTeamTaskInput,
	s: TeamStore = store(),
): Promise<TeamTaskRow> {
	return s.createTask(input);
}

/**
 * Atomically claim the oldest eligible task for `sessionId`. Eligible = pending,
 * unassigned, and every id in depends_on is completed. Returns the claimed task,
 * or null when nothing is claimable.
 *
 * NOTE ON TESTING: PGlite is single-connection, so its unit tests prove the
 * claim CONTRACT (select-and-mutate exclusion, dependency gating) deterministically
 * but cannot exercise true multi-connection SKIP-LOCKED contention. That final
 * guarantee is validated by the dev-cluster end-to-end run (see
 * scripts/verify-agent-teams-dev.sh) against real Postgres.
 */
export function claimNextTask(
	input: { teamId: string; sessionId: string },
	s: TeamStore = store(),
): Promise<TeamTaskRow | null> {
	return s.claimNextTask(input);
}

/**
 * Count tasks that are claimable RIGHT NOW (pending, unassigned, all deps
 * completed). The driver uses this to avoid the idle→nudge→idle loop: only nudge
 * an idle teammate to claim when there is actually claimable work.
 */
export function countClaimableTasks(
	teamId: string,
	s: TeamStore = store(),
): Promise<number> {
	return s.countClaimableTasks(teamId);
}

/** Mark a claimed task completed; `note` persists the deliverable (results
 * channel). Unblocks dependents on the next claim. */
export function completeTask(
	input: { teamId: string; taskId: string; note?: string | null },
	s: TeamStore = store(),
): Promise<TeamTaskRow | null> {
	return s.completeTask(input);
}

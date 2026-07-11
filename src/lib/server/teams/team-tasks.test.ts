/**
 * Atomic-claim contract for the Agent Teams shared task list.
 *
 * Runs the REAL claim SQL against PGlite (in-process Postgres), so it proves the
 * select-and-mutate exclusion and dependency gating for real, not via mocks.
 * PGlite is single-connection, so it cannot exercise true multi-connection
 * SKIP-LOCKED contention — that is covered by the dev-cluster E2E. What this
 * pins down: no task is ever handed to two teammates, and a blocked task is not
 * claimable until its dependency completes.
 */

import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";
import { PostgresTeamStore } from "$lib/server/application/adapters/team-store";
import type { TeamStore } from "$lib/server/application/ports";
import { claimNextTask, completeTask, createTask } from "$lib/server/teams/team-tasks";

const TEAM = "team-1";

/** A PGlite-backed TeamStore with the team_tasks schema created. */
async function freshStore(): Promise<TeamStore> {
	const { db } = createPgliteDb();
	// Mirror the team_tasks columns from drizzle/00NN_agent_teams.sql.
	await db.execute(
		sql.raw(`
		CREATE TABLE IF NOT EXISTS team_tasks (
			id text PRIMARY KEY,
			team_id text NOT NULL,
			title text NOT NULL,
			description text,
			status text NOT NULL DEFAULT 'pending',
			assignee_session_id text,
			depends_on jsonb NOT NULL DEFAULT '[]'::jsonb,
			created_by_session_id text,
			created_at timestamp NOT NULL DEFAULT now(),
			updated_at timestamp NOT NULL DEFAULT now(),
			completed_at timestamp,
			completion_note text
		)`),
	);
	return new PostgresTeamStore(() => db as never);
}

describe("team-tasks atomic claim", () => {
	let store: TeamStore;
	beforeEach(async () => {
		store = await freshStore();
	});

	it("claims an eligible task and stamps status + assignee", async () => {
		const t = await createTask({ teamId: TEAM, title: "A" }, store);
		const claimed = await claimNextTask({ teamId: TEAM, sessionId: "sess-x" }, store);
		expect(claimed?.id).toBe(t.id);
		expect(claimed?.status).toBe("in_progress");
		expect(claimed?.assignee_session_id).toBe("sess-x");
	});

	it("persists the completion note (the results channel) and lists it back", async () => {
		const t = await createTask({ teamId: TEAM, title: "deliver" }, store);
		await claimNextTask({ teamId: TEAM, sessionId: "s1" }, store);
		const done = await completeTask(
			{ teamId: TEAM, taskId: t.id, note: "THE DELIVERABLE: five crisp use-cases…" },
			store,
		);
		expect(done?.completion_note).toBe("THE DELIVERABLE: five crisp use-cases…");
		const listed = await store.listTeamTasks(TEAM);
		expect(listed[0].completion_note).toBe("THE DELIVERABLE: five crisp use-cases…");
		// A note-less re-complete must not WIPE an existing note (coalesce).
		await completeTask({ teamId: TEAM, taskId: t.id }, store);
		const again = await store.listTeamTasks(TEAM);
		expect(again[0].completion_note).toBe("THE DELIVERABLE: five crisp use-cases…");
	});

	it("never double-assigns a single task under concurrent claims", async () => {
		await createTask({ teamId: TEAM, title: "only" }, store);
		const [a, b] = await Promise.all([
			claimNextTask({ teamId: TEAM, sessionId: "s1" }, store),
			claimNextTask({ teamId: TEAM, sessionId: "s2" }, store),
		]);
		const winners = [a, b].filter(Boolean);
		expect(winners).toHaveLength(1); // exactly one teammate got it
	});

	it("assigns each task at most once across more claims than tasks", async () => {
		for (let i = 0; i < 5; i++) {
			await createTask({ teamId: TEAM, title: `t${i}` }, store);
		}
		const claims = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				claimNextTask({ teamId: TEAM, sessionId: `s${i}` }, store),
			),
		);
		const ids = claims.filter(Boolean).map((c) => c!.id);
		expect(new Set(ids).size).toBe(ids.length); // no id claimed twice
		expect(ids).toHaveLength(5); // 5 tasks claimed, 3 empty claims returned null
	});

	it("reserves a pre-assigned pending task for its designee (queue mode)", async () => {
		const reserved = await createTask(
			{ teamId: TEAM, title: "reserved", assigneeSessionId: "sess-me", status: "pending" },
			store,
		);
		// Another teammate cannot claim it...
		const other = await claimNextTask({ teamId: TEAM, sessionId: "sess-other" }, store);
		expect(other).toBeNull();
		// ...but the designee can.
		const mine = await claimNextTask({ teamId: TEAM, sessionId: "sess-me" }, store);
		expect(mine?.id).toBe(reserved.id);
		expect(mine?.status).toBe("in_progress");
	});

	it("prefers the caller's reserved task over an OLDER open task", async () => {
		const open = await createTask({ teamId: TEAM, title: "open-first" }, store);
		const reserved = await createTask(
			{ teamId: TEAM, title: "reserved-later", assigneeSessionId: "sess-me", status: "pending" },
			store,
		);
		// Despite the open task being older, the designee gets its own work first.
		const mine = await claimNextTask({ teamId: TEAM, sessionId: "sess-me" }, store);
		expect(mine?.id).toBe(reserved.id);
		// The open task remains for anyone else.
		const other = await claimNextTask({ teamId: TEAM, sessionId: "sess-other" }, store);
		expect(other?.id).toBe(open.id);
	});

	it("does not claim a task with an unmet dependency until it completes", async () => {
		const dep = await createTask({ teamId: TEAM, title: "dep" }, store);
		const blocked = await createTask(
			{ teamId: TEAM, title: "blocked", dependsOn: [dep.id] },
			store,
		);

		// First claim returns the dependency-free task, never the blocked one.
		const first = await claimNextTask({ teamId: TEAM, sessionId: "s1" }, store);
		expect(first?.id).toBe(dep.id);

		// Blocked task is still not claimable (dep is in_progress, not completed).
		const none = await claimNextTask({ teamId: TEAM, sessionId: "s2" }, store);
		expect(none).toBeNull();

		// Completing the dependency unblocks it.
		await completeTask({ teamId: TEAM, taskId: dep.id }, store);
		const now = await claimNextTask({ teamId: TEAM, sessionId: "s2" }, store);
		expect(now?.id).toBe(blocked.id);
	});
});

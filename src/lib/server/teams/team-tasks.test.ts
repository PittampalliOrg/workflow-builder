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
import {
	claimNextTask,
	completeTask,
	createTask,
	type TeamTasksDb,
} from "$lib/server/teams/team-tasks";

const TEAM = "team-1";

async function freshDb(): Promise<TeamTasksDb> {
	const { db } = createPgliteDb();
	const typed = db as unknown as TeamTasksDb;
	// Mirror the team_tasks columns from drizzle/00NN_agent_teams.sql.
	await typed.execute(
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
			completed_at timestamp
		)`),
	);
	return typed;
}

describe("team-tasks atomic claim", () => {
	let db: TeamTasksDb;
	beforeEach(async () => {
		db = await freshDb();
	});

	it("claims an eligible task and stamps status + assignee", async () => {
		const t = await createTask(db, { teamId: TEAM, title: "A" });
		const claimed = await claimNextTask(db, { teamId: TEAM, sessionId: "sess-x" });
		expect(claimed?.id).toBe(t.id);
		expect(claimed?.status).toBe("in_progress");
		expect(claimed?.assignee_session_id).toBe("sess-x");
	});

	it("never double-assigns a single task under concurrent claims", async () => {
		await createTask(db, { teamId: TEAM, title: "only" });
		const [a, b] = await Promise.all([
			claimNextTask(db, { teamId: TEAM, sessionId: "s1" }),
			claimNextTask(db, { teamId: TEAM, sessionId: "s2" }),
		]);
		const winners = [a, b].filter(Boolean);
		expect(winners).toHaveLength(1); // exactly one teammate got it
	});

	it("assigns each task at most once across more claims than tasks", async () => {
		for (let i = 0; i < 5; i++) {
			await createTask(db, { teamId: TEAM, title: `t${i}` });
		}
		const claims = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				claimNextTask(db, { teamId: TEAM, sessionId: `s${i}` }),
			),
		);
		const ids = claims.filter(Boolean).map((c) => c!.id);
		expect(new Set(ids).size).toBe(ids.length); // no id claimed twice
		expect(ids).toHaveLength(5); // 5 tasks claimed, 3 empty claims returned null
	});

	it("does not claim a task with an unmet dependency until it completes", async () => {
		const dep = await createTask(db, { teamId: TEAM, title: "dep" });
		const blocked = await createTask(db, {
			teamId: TEAM,
			title: "blocked",
			dependsOn: [dep.id],
		});

		// First claim returns the dependency-free task, never the blocked one.
		const first = await claimNextTask(db, { teamId: TEAM, sessionId: "s1" });
		expect(first?.id).toBe(dep.id);

		// Blocked task is still not claimable (dep is in_progress, not completed).
		const none = await claimNextTask(db, { teamId: TEAM, sessionId: "s2" });
		expect(none).toBeNull();

		// Completing the dependency unblocks it.
		await completeTask(db, { teamId: TEAM, taskId: dep.id });
		const now = await claimNextTask(db, { teamId: TEAM, sessionId: "s2" });
		expect(now?.id).toBe(blocked.id);
	});
});

/**
 * Script-led team store methods against real PGlite: lead-anchor provisioning
 * idempotency, execution context, assigned task creation, execution adoption in
 * ensureTeamRunExecution, and the refreshTeamRunStatus engine guard (the
 * adoption-clobber bug this feature must not introduce).
 */

import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";
import { PostgresTeamStore } from "$lib/server/application/adapters/team-store";
import { reconcileTeamMemberLaunches } from "$lib/server/application/team-member-launch-reconciler";
import type {
  TeamMemberPeerDispatchRecipe,
  TeamStore,
} from "$lib/server/application/ports";
import { ensureTeam } from "$lib/server/teams/team-repo";
import { ensureTeamRunExecution } from "$lib/server/teams/team-run";

type Pglite = ReturnType<typeof createPgliteDb>["db"];

const EXEC = "exec-abc123";

function launchRecipe(sessionId: string): TeamMemberPeerDispatchRecipe {
  return {
    version: 1,
    teamId: "team-1",
    principal: {
      userId: "user-1",
      projectId: "proj-1",
      sessionId: "lead-1",
      capabilities: {
        scriptDepth: 0,
        teamId: "team-1",
        teamRole: "lead",
      },
    },
    request: {
      sessionId,
      peerAgentId: "worker-agent",
      peerAgentVersion: 1,
      prompt: "Do the work",
      parentSessionId: "lead-1",
      title: "teammate:worker",
      skipSpawn: false,
      provisionSandbox: true,
      sandboxTemplate: null,
    },
  };
}

async function fresh(): Promise<{ db: Pglite; store: TeamStore }> {
	const { db } = createPgliteDb();
	await db.execute(
		sql.raw(
			`CREATE TABLE agents (id text primary key, name text not null, slug text not null unique, model jsonb, is_default boolean default false, is_enabled boolean default true, is_archived boolean default false, user_id text)`,
		),
	);
	await db.execute(
		sql.raw(
      `CREATE TABLE sessions (id text primary key, user_id text not null, project_id text, agent_id text not null references agents(id), agent_version integer, status text default 'idle', title text, workflow_execution_id text, parent_execution_id text, dapr_instance_id text, runtime_app_id text, runtime_sandbox_name text, runtime_provisioning_started_at timestamp, last_event_at timestamp, stop_requested_at timestamp, stop_requested_mode text, completed_at timestamp, updated_at timestamp)`,
		),
	);
	await db.execute(
		sql.raw(
      `CREATE TABLE workflow_executions (id text primary key, user_id text not null, project_id text, status text default 'running', phase text, progress int default 0, execution_ir jsonb, stop_requested_at timestamp, completed_at timestamp)`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE teams (id text primary key, workflow_execution_id text, project_id text not null, name text, lead_session_id text not null, status text default 'active', token_budget int, created_at timestamp default now(), updated_at timestamp default now())`,
		),
	);
	await db.execute(
		sql.raw(
      `CREATE TABLE team_members (
					id text primary key,
					team_id text not null,
					session_id text unique not null,
					agent_slug text,
					name text not null,
					role text default 'member',
					model text,
					status text default 'working',
					plan_mode_required boolean default false,
					joined_at timestamp default now(),
					updated_at timestamp default now(),
					launch_operation_id text,
					launch_kind text,
					launch_started_at timestamp,
					launch_completed_at timestamp,
					launch_cleanup_requested_at timestamp,
					launch_cleanup_action text,
					launch_previous_session_id text,
					launch_previous_status text,
					launch_dispatch_recipe jsonb,
					UNIQUE (team_id, name),
					CONSTRAINT team_members_launch_kind_check CHECK (
						launch_kind IS NULL OR launch_kind IN ('spawn', 'revival')
					),
					CONSTRAINT team_members_launch_metadata_consistent CHECK (
						(
							launch_operation_id IS NULL
							AND launch_kind IS NULL
							AND launch_started_at IS NULL
							AND launch_completed_at IS NULL
							AND launch_cleanup_requested_at IS NULL
							AND launch_cleanup_action IS NULL
							AND launch_previous_session_id IS NULL
							AND launch_previous_status IS NULL
							AND launch_dispatch_recipe IS NULL
						)
						OR (
							launch_operation_id IS NOT NULL
							AND launch_kind IS NOT NULL
							AND launch_started_at IS NOT NULL
							AND launch_dispatch_recipe IS NOT NULL
							AND jsonb_typeof(launch_dispatch_recipe) = 'object'
							AND NOT (
								launch_completed_at IS NOT NULL
								AND launch_cleanup_requested_at IS NOT NULL
							)
							AND (
								(
									launch_cleanup_requested_at IS NULL
									AND launch_cleanup_action IS NULL
								)
								OR (
									launch_cleanup_requested_at IS NOT NULL
									AND launch_cleanup_action IS NOT NULL
									AND launch_cleanup_action IN ('purge', 'unwind')
								)
							)
							AND (
								(
									launch_kind = 'spawn'
									AND launch_previous_session_id IS NULL
									AND launch_previous_status IS NULL
								)
								OR (
									launch_kind = 'revival'
									AND launch_previous_session_id IS NOT NULL
									AND launch_previous_status IS NOT NULL
									AND launch_previous_status IN ('failed', 'shutdown')
								)
							)
						)
					)
				)`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE team_tasks (id text primary key, team_id text not null, title text not null, description text, status text default 'pending', assignee_session_id text, depends_on jsonb default '[]'::jsonb, created_by_session_id text, created_at timestamp default now(), updated_at timestamp default now(), completed_at timestamp, completion_note text)`,
		),
	);
	await db.execute(sql`
		INSERT INTO workflow_executions (id, user_id, project_id, status, execution_ir)
		VALUES (${EXEC}, 'user-1', 'proj-1', 'running', '{"engine":"dynamic-script"}'::jsonb)
	`);
	return { db, store: new PostgresTeamStore(() => db as never) };
}

describe("script-led team store", () => {
	let db: Pglite;
	let store: TeamStore;
	beforeEach(async () => {
		({ db, store } = await fresh());
	});

	it("getExecutionContext returns owner scope; null for unknown", async () => {
		expect(await store.getExecutionContext(EXEC)).toEqual({
			userId: "user-1",
			projectId: "proj-1",
		});
		expect(await store.getExecutionContext("nope")).toBeNull();
	});

	it("ensureScriptLeadSession is idempotent and stamps the execution", async () => {
		const input = {
			sessionId: `dsw-team-lead-${EXEC}`,
			userId: "user-1",
			projectId: "proj-1",
			executionId: EXEC,
		};
		await store.ensureScriptLeadSession(input);
		await store.ensureScriptLeadSession(input); // no throw on repeat
		const rows = (await db.execute(
			sql`SELECT agent_id, workflow_execution_id, status FROM sessions WHERE id = ${input.sessionId}`,
    )) as Array<{
      agent_id: string;
      workflow_execution_id: string;
      status: string;
    }>;
		expect(rows).toHaveLength(1);
		expect(rows[0].agent_id).toBe("script-team-lead");
		expect(rows[0].workflow_execution_id).toBe(EXEC);
		const agents = (await db.execute(
			sql`SELECT is_archived FROM agents WHERE slug = 'script-team-lead'`,
		)) as Array<{ is_archived: boolean }>;
		expect(agents).toHaveLength(1);
		expect(agents[0].is_archived).toBe(true);
	});

	it("createTask supports pre-assignment (in_progress, not claimable)", async () => {
		const task = await store.createTask({
			teamId: "t1",
			title: "assigned work",
			assigneeSessionId: "sess-m1",
			status: "in_progress",
		});
		expect(task.status).toBe("in_progress");
		expect(task.assignee_session_id).toBe("sess-m1");
		// Pre-assigned tasks must not be claimable.
    expect(
      await store.claimNextTask({ teamId: "t1", sessionId: "thief" }),
    ).toBeNull();
		// Default stays pending/unassigned.
		const plain = await store.createTask({ teamId: "t1", title: "open work" });
		expect(plain.status).toBe("pending");
		expect(plain.assignee_session_id).toBeNull();
	});

  it("excludes sessions with a pending stop request from suspend candidates", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug)
			VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, agent_id, status, dapr_instance_id,
				runtime_sandbox_name, last_event_at, stop_requested_at
			) VALUES
				('idle-live', 'user-1', 'worker-agent', 'idle', 'run-live',
				 'sandbox-live', now() - interval '20 minutes', NULL),
				('idle-stopping', 'user-1', 'worker-agent', 'idle', 'run-stopping',
				 'sandbox-stopping', now() - interval '20 minutes', now())
		`);
    await db.execute(sql`
			INSERT INTO team_members (
				id, team_id, session_id, name, role, status, updated_at
			) VALUES
				('member-live', 'team-1', 'idle-live', 'live', 'member', 'idle', now() - interval '20 minutes'),
				('member-stopping', 'team-1', 'idle-stopping', 'stopping', 'member', 'idle', now() - interval '20 minutes')
		`);

    const candidates = await store.listSuspendCandidates({ idleSeconds: 300 });

    expect(candidates.map((candidate) => candidate.session_id)).toEqual([
      "idle-live",
    ]);
  });

  it("re-publishes stranded mailbox triggers for both leads and members", async () => {
    await db.execute(
      sql.raw(`
			CREATE TABLE session_events (
				id text PRIMARY KEY,
				session_id text NOT NULL,
				type text NOT NULL,
				data jsonb NOT NULL DEFAULT '{}'::jsonb,
				processed_at timestamp,
				created_at timestamp NOT NULL DEFAULT now()
			)
		`),
    );
    await db.execute(sql`
			INSERT INTO agents (id, name, slug)
			VALUES ('mailbox-agent', 'Mailbox', 'mailbox-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (id, user_id, agent_id, status, dapr_instance_id)
			VALUES
				('lead-mailbox', 'user-1', 'mailbox-agent', 'idle', 'run-lead'),
				('member-mailbox', 'user-1', 'mailbox-agent', 'idle', 'run-member')
		`);
    await db.execute(sql`
			INSERT INTO team_members (id, team_id, session_id, name, role, status)
			VALUES
				('lead-row', 'team-mailbox', 'lead-mailbox', 'lead', 'lead', 'idle'),
				('member-row', 'team-mailbox', 'member-mailbox', 'member', 'member', 'idle')
		`);
    await db.execute(sql`
			INSERT INTO session_events (id, session_id, type, data, created_at)
			VALUES
				('lead-event', 'lead-mailbox', 'user.message', '{"origin":"teammate-message"}'::jsonb, now() - interval '10 minutes'),
				('member-event', 'member-mailbox', 'user.message', '{"origin":"team-broadcast"}'::jsonb, now() - interval '10 minutes')
		`);

    const stranded = await store.listSessionsWithStrandedTeamMessages({
      olderThanSeconds: 120,
    });
    expect(stranded.map((row) => row.session_id).sort()).toEqual([
      "lead-mailbox",
      "member-mailbox",
    ]);
  });

  it("atomically transitions only active, non-stopping, nonterminal members", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug) VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (id, user_id, agent_id, status, stop_requested_at)
			VALUES
				('live', 'user-1', 'worker-agent', 'idle', NULL),
				('stopping', 'user-1', 'worker-agent', 'idle', now()),
				('terminal-session', 'user-1', 'worker-agent', 'terminated', NULL),
				('shutdown-member', 'user-1', 'worker-agent', 'idle', NULL)
		`);
    await db.execute(sql`
			INSERT INTO team_members (id, team_id, session_id, name, role, status)
			VALUES
				('m-live', 'team-1', 'live', 'live', 'member', 'idle'),
				('m-stopping', 'team-1', 'stopping', 'stopping', 'member', 'idle'),
				('m-terminal-session', 'team-1', 'terminal-session', 'terminal-session', 'member', 'idle'),
				('m-shutdown', 'team-1', 'shutdown-member', 'shutdown-member', 'member', 'shutdown')
		`);

    expect(
      await store.transitionActiveMemberStatus({
        sessionId: "live",
        expectedStatuses: ["idle"],
        status: "suspended",
      }),
    ).toBe(true);
    for (const sessionId of [
      "stopping",
      "terminal-session",
      "shutdown-member",
    ]) {
      expect(
        await store.transitionActiveMemberStatus({
          sessionId,
          expectedStatuses: ["idle"],
          status: "suspended",
        }),
      ).toBe(false);
    }
    const statuses = (await db.execute(sql`
			SELECT session_id, status FROM team_members ORDER BY session_id
		`)) as Array<{ session_id: string; status: string }>;
    expect(
      Object.fromEntries(statuses.map((row) => [row.session_id, row.status])),
    ).toEqual({
      live: "suspended",
      "shutdown-member": "shutdown",
      stopping: "idle",
      "terminal-session": "idle",
    });
  });

  it("finalizes shutdown only for the exact member/session mapping", async () => {
    await db.execute(sql`
			INSERT INTO team_members (id, team_id, session_id, name, role, status)
			VALUES ('member-1', 'team-1', 'session-1', 'worker', 'member', 'working')
		`);

    expect(
      await store.finalizeMemberShutdown({
        memberId: "member-1",
        sessionId: "session-1",
      }),
    ).toBe("updated");
    expect(
      await store.finalizeMemberShutdown({
        memberId: "member-1",
        sessionId: "session-1",
      }),
    ).toBe("already_terminal");
    await db.execute(sql`
			UPDATE team_members SET session_id = 'session-2', status = 'working'
			WHERE id = 'member-1'
		`);
    expect(
      await store.finalizeMemberShutdown({
        memberId: "member-1",
        sessionId: "session-1",
      }),
    ).toBe("stale");
    const rows = (await db.execute(sql`
			SELECT status FROM team_members WHERE id = 'member-1'
		`)) as Array<{ status: string }>;
    expect(rows[0].status).toBe("working");
  });

  it("repoints a terminal member only onto a live, correctly linked revival", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug) VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, status, workflow_execution_id,
				parent_execution_id, stop_requested_at, completed_at
			) VALUES
				('lead-1', 'user-1', 'proj-1', 'worker-agent', 'running', ${EXEC}, NULL, NULL, NULL),
				('old-1', 'user-1', 'proj-1', 'worker-agent', 'terminated', ${EXEC}, 'lead-1', now(), now()),
				('new-1', 'user-1', 'proj-1', 'worker-agent', 'rescheduling', ${EXEC}, 'lead-1', NULL, NULL)
		`);
    await db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
			VALUES ('team-1', ${EXEC}, 'proj-1', 'team', 'lead-1')
		`);
    await db.execute(sql`
			INSERT INTO team_members (id, team_id, session_id, name, role, status)
			VALUES ('member-1', 'team-1', 'old-1', 'worker', 'member', 'shutdown')
		`);

    const input = {
      memberId: "member-1",
      previousSessionId: "old-1",
      sessionId: "new-1",
      status: "working" as const,
    };
    expect(await store.setMemberSession(input)).toBe(true);
    // A replay of the same deterministic revival is idempotent.
    expect(await store.setMemberSession(input)).toBe(true);
    const rows = (await db.execute(sql`
			SELECT session_id, status FROM team_members WHERE id = 'member-1'
		`)) as Array<{ session_id: string; status: string }>;
    expect(rows[0]).toEqual({ session_id: "new-1", status: "working" });
  });

  it("refuses a revival after member, child, lead, or workflow state changes", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug) VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, status, workflow_execution_id,
				parent_execution_id, stop_requested_at, completed_at
			) VALUES
				('lead-1', 'user-1', 'proj-1', 'worker-agent', 'running', ${EXEC}, NULL, NULL, NULL),
				('old-1', 'user-1', 'proj-1', 'worker-agent', 'terminated', ${EXEC}, 'lead-1', now(), now()),
				('new-1', 'user-1', 'proj-1', 'worker-agent', 'rescheduling', ${EXEC}, 'lead-1', NULL, NULL)
		`);
    await db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
			VALUES ('team-1', ${EXEC}, 'proj-1', 'team', 'lead-1')
		`);
    await db.execute(sql`
			INSERT INTO team_members (id, team_id, session_id, name, role, status)
			VALUES ('member-1', 'team-1', 'old-1', 'worker', 'member', 'shutdown')
		`);
    const input = {
      memberId: "member-1",
      previousSessionId: "old-1",
      sessionId: "new-1",
      status: "working" as const,
    };

    await db.execute(
      sql`UPDATE sessions SET stop_requested_at = now() WHERE id = 'new-1'`,
    );
    expect(await store.setMemberSession(input)).toBe(false);
    await db.execute(
      sql`UPDATE sessions SET stop_requested_at = NULL WHERE id = 'new-1'`,
    );
    await db.execute(
      sql`UPDATE sessions SET stop_requested_at = now() WHERE id = 'lead-1'`,
    );
    expect(await store.setMemberSession(input)).toBe(false);
    await db.execute(
      sql`UPDATE sessions SET stop_requested_at = NULL WHERE id = 'lead-1'`,
    );
    await db.execute(
      sql`UPDATE workflow_executions SET stop_requested_at = now() WHERE id = ${EXEC}`,
    );
    expect(await store.setMemberSession(input)).toBe(false);
    await db.execute(
      sql`UPDATE workflow_executions SET stop_requested_at = NULL WHERE id = ${EXEC}`,
    );
    await db.execute(
      sql`UPDATE team_members SET status = 'working' WHERE id = 'member-1'`,
    );
    expect(await store.setMemberSession(input)).toBe(false);

    const rows = (await db.execute(sql`
			SELECT session_id, status FROM team_members WHERE id = 'member-1'
		`)) as Array<{ session_id: string; status: string }>;
    expect(rows[0]).toEqual({ session_id: "old-1", status: "working" });
  });

  it("reserves a new member as non-working only while team, lead, and execution are active", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug) VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, status, workflow_execution_id
			) VALUES ('lead-1', 'user-1', 'proj-1', 'worker-agent', 'running', ${EXEC})
		`);
    await db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
			VALUES ('team-1', ${EXEC}, 'proj-1', 'team', 'lead-1')
		`);

    const input = {
      teamId: "team-1",
      sessionId: "new-1",
      name: "worker",
      agentSlug: "worker-agent",
      dispatchRecipe: launchRecipe("new-1"),
    };
    const reservation = await store.beginMemberSpawn(input);
    const member = reservation?.member;
    expect(reservation).toEqual({
      state: "acquired",
      dispatchRecipe: launchRecipe("new-1"),
      member: expect.objectContaining({
        team_id: "team-1",
        session_id: "new-1",
        name: "worker",
        status: "starting",
      }),
    });
    const replay = await store.beginMemberSpawn(input);
    expect(replay).toEqual({
      state: "reserved",
      dispatchRecipe: launchRecipe("new-1"),
      member: expect.objectContaining({
        id: member!.id,
        launch_operation_id: member!.launch_operation_id,
        status: "starting",
      }),
    });
    expect(
      await store.beginMemberSpawn({
        ...input,
        dispatchRecipe: {
          ...input.dispatchRecipe,
          request: {
            ...input.dispatchRecipe.request,
            peerAgentVersion: 2,
          },
        },
      }),
    ).toBeNull();
    expect(
      await store.beginMemberSpawn({
        ...input,
        sessionId: "conflict-1",
        dispatchRecipe: launchRecipe("conflict-1"),
      }),
    ).toBeNull();

    await db.execute(
      sql`UPDATE sessions SET stop_requested_at = now() WHERE id = 'lead-1'`,
    );
    expect(
      await store.beginMemberSpawn({
        teamId: "team-1",
        sessionId: "new-2",
        name: "worker-2",
        dispatchRecipe: launchRecipe("new-2"),
      }),
    ).toBeNull();
    await db.execute(
      sql`UPDATE sessions SET stop_requested_at = NULL WHERE id = 'lead-1'`,
    );
    await db.execute(
      sql`UPDATE workflow_executions SET stop_requested_at = now() WHERE id = ${EXEC}`,
    );
    expect(
      await store.beginMemberSpawn({
        teamId: "team-1",
        sessionId: "new-3",
        name: "worker-3",
        dispatchRecipe: launchRecipe("new-3"),
      }),
    ).toBeNull();
  });

  it("promotes a starting member only after its exact runtime generation is published", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug) VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, status, workflow_execution_id
			) VALUES ('lead-1', 'user-1', 'proj-1', 'worker-agent', 'running', ${EXEC})
		`);
    await db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
			VALUES ('team-1', ${EXEC}, 'proj-1', 'team', 'lead-1')
		`);
    const reservation = await store.beginMemberSpawn({
      teamId: "team-1",
      sessionId: "new-1",
      name: "worker",
      dispatchRecipe: launchRecipe("new-1"),
    });
    const member = reservation?.member;
    expect(member).not.toBeNull();
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, agent_version, status, workflow_execution_id,
				parent_execution_id, runtime_provisioning_started_at
			) VALUES ('new-1', 'user-1', 'proj-1', 'worker-agent', 1, 'rescheduling', ${EXEC}, 'lead-1', now())
		`);
    expect(
      await store.promoteStartingMember({
        memberId: member!.id,
        sessionId: "new-1",
        operationId: member!.launch_operation_id!,
      }),
    ).toBe(false);
    await db.execute(sql`
			UPDATE sessions
			SET dapr_instance_id = 'new-1',
			    runtime_app_id = 'agent-session-new-1-g1',
			    runtime_provisioning_started_at = NULL
			WHERE id = 'new-1'
		`);
    expect(
      await store.promoteStartingMember({
        memberId: member!.id,
        sessionId: "new-1",
        operationId: member!.launch_operation_id!,
      }),
    ).toBe(true);
    const rows = (await db.execute(sql`
				SELECT status, launch_dispatch_recipe
				FROM team_members WHERE id = ${member!.id}
			`)) as Array<{
      status: string;
      launch_dispatch_recipe: TeamMemberPeerDispatchRecipe;
    }>;
    expect(rows[0]).toEqual({
      status: "working",
      launch_dispatch_recipe: launchRecipe("new-1"),
    });
    expect(
      await store.beginMemberSpawn({
        teamId: "team-1",
        sessionId: "new-1",
        name: "worker",
        dispatchRecipe: launchRecipe("new-1"),
      }),
    ).toEqual({
      state: "active",
      dispatchRecipe: launchRecipe("new-1"),
      member: expect.objectContaining({
        id: member!.id,
        launch_operation_id: member!.launch_operation_id,
        status: "working",
      }),
    });
    await db.execute(
      sql`UPDATE sessions SET stop_requested_at = now() WHERE id = 'new-1'`,
    );
    await expect(
      store.promoteStartingMember({
        memberId: member!.id,
        sessionId: "new-1",
        operationId: member!.launch_operation_id!,
      }),
    ).resolves.toBe(false);
    await expect(
      store.findMemberSpawnReplay({
        teamId: "team-1",
        sessionId: "new-1",
        name: "worker",
      }),
    ).resolves.toBeNull();
  });

  it("locks promotion authority in lifecycle order before the member CAS", () => {
    const source = readFileSync(
      new URL("./team-store.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("private async resolveStartingMemberLaunch");
    const end = source.indexOf("async cancelMemberSpawn", start);
    const promotion = source.slice(start, end);
    const transaction = promotion.indexOf("database.transaction");
    const workflowLock = promotion.indexOf(
      "FROM workflow_executions AS execution",
    );
    const leadLock = promotion.indexOf("FROM sessions AS lead");
    const childLock = promotion.indexOf("FROM sessions AS child");
    const memberLock = promotion.indexOf("FOR UPDATE OF member");
    const memberCas = promotion.lastIndexOf("UPDATE team_members");

    expect(transaction).toBeGreaterThanOrEqual(0);
    expect(workflowLock).toBeGreaterThan(transaction);
    expect(leadLock).toBeGreaterThan(workflowLock);
    expect(childLock).toBeGreaterThan(leadLock);
    expect(memberLock).toBeGreaterThan(childLock);
    expect(memberCas).toBeGreaterThan(memberLock);

    const cleanupStart = source.indexOf("async requestMemberLaunchCleanup");
    const cleanupEnd = source.indexOf(
      "private async resolveStartingMemberLaunch",
      cleanupStart,
    );
    const cleanup = source.slice(cleanupStart, cleanupEnd);
    const cleanupChildLock = cleanup.indexOf("FOR UPDATE OF child");
    const cleanupMemberLock = cleanup.indexOf("FOR UPDATE OF member");
    const cleanupStopFence = cleanup.indexOf("UPDATE sessions");

    expect(cleanupChildLock).toBeGreaterThanOrEqual(0);
    expect(cleanupMemberLock).toBeGreaterThan(cleanupChildLock);
    expect(cleanupStopFence).toBeGreaterThan(cleanupMemberLock);
  });

  it("reserves and exactly compensates a terminal member revival", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug) VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, status, workflow_execution_id
			) VALUES ('lead-1', 'user-1', 'proj-1', 'worker-agent', 'running', ${EXEC})
		`);
    await db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
			VALUES ('team-1', ${EXEC}, 'proj-1', 'team', 'lead-1')
		`);
    await db.execute(sql`
			INSERT INTO team_members (id, team_id, session_id, name, role, status)
			VALUES ('member-1', 'team-1', 'old-1', 'worker', 'member', 'shutdown')
		`);
    const input = {
      teamId: "team-1",
      memberId: "member-1",
      previousSessionId: "old-1",
      previousStatus: "shutdown" as const,
      sessionId: "new-1",
      dispatchRecipe: launchRecipe("new-1"),
    };

    const reservation = await store.beginMemberRevival(input);
    const revival = reservation?.member;
    expect(reservation).toEqual({
      state: "acquired",
      dispatchRecipe: launchRecipe("new-1"),
      member: expect.objectContaining({
        session_id: "new-1",
        status: "starting",
      }),
    });
    expect(await store.beginMemberRevival(input)).toEqual({
      state: "reserved",
      dispatchRecipe: launchRecipe("new-1"),
      member: expect.objectContaining({
        id: revival!.id,
        launch_operation_id: revival!.launch_operation_id,
        status: "starting",
      }),
    });
    expect(
      await store.beginMemberRevival({
        ...input,
        dispatchRecipe: {
          ...input.dispatchRecipe,
          request: {
            ...input.dispatchRecipe.request,
            peerAgentVersion: 2,
          },
        },
      }),
    ).toBeNull();
    expect(
      await store.findMemberRevivalReplay({
        teamId: "team-1",
        name: "worker",
      }),
    ).toEqual(
      expect.objectContaining({
        state: "reserved",
        member: expect.objectContaining({ id: revival!.id }),
      }),
    );
    expect(
      await store.beginMemberRevival({
        ...input,
        sessionId: "conflict-new",
        dispatchRecipe: launchRecipe("conflict-new"),
      }),
    ).toBeNull();
    expect(
      await store.cancelMemberRevival({
        ...input,
        sessionId: "stale-new",
        operationId: revival!.launch_operation_id!,
      }),
    ).toBe(false);
    expect(
      await store.cancelMemberRevival({
        ...input,
        operationId: revival!.launch_operation_id!,
      }),
    ).toBe(true);
    const rows = (await db.execute(sql`
				SELECT session_id, status, launch_dispatch_recipe
				FROM team_members WHERE id = 'member-1'
			`)) as Array<{
      session_id: string;
      status: string;
      launch_dispatch_recipe: unknown;
    }>;
    expect(rows[0]).toEqual({
      session_id: "old-1",
      status: "shutdown",
      launch_dispatch_recipe: null,
    });
  });

  it("deletes only an exact unpromoted new-member reservation", async () => {
    await db.execute(sql`
				INSERT INTO team_members (
					id, team_id, session_id, name, role, status,
					launch_operation_id, launch_kind, launch_started_at,
					launch_dispatch_recipe
				)
				VALUES (
					'member-1', 'team-1', 'new-1', 'worker', 'member', 'starting',
					'launch-1', 'spawn', now(),
					${JSON.stringify(launchRecipe("new-1"))}::jsonb
				)
			`);
    expect(
      await store.cancelMemberSpawn({
        memberId: "member-1",
        sessionId: "wrong-session",
        operationId: "launch-1",
      }),
    ).toBe(false);
    expect(
      await store.cancelMemberSpawn({
        memberId: "member-1",
        sessionId: "new-1",
        operationId: "launch-1",
      }),
    ).toBe(true);
    expect(await store.getMemberByName("team-1", "worker")).toBeNull();
  });

  it("durably fences cleanup only for the exact starting launch", async () => {
    await db.execute(sql`
				INSERT INTO teams (id, project_id, name, lead_session_id)
				VALUES ('team-1', 'proj-1', 'team', 'lead-1')
			`);
    await db.execute(sql`
				INSERT INTO team_members (
					id, team_id, session_id, name, role, status,
					launch_operation_id, launch_kind, launch_started_at,
					launch_dispatch_recipe
				)
				VALUES (
					'member-1', 'team-1', 'child-1', 'worker', 'member', 'starting',
					'launch-1', 'spawn', now(),
					${JSON.stringify(launchRecipe("child-1"))}::jsonb
				)
			`);

    await expect(
      store.requestMemberLaunchCleanup({
        memberId: "member-1",
        sessionId: "child-1",
        operationId: "wrong-operation",
      }),
    ).resolves.toBeNull();
    await expect(
      store.requestMemberLaunchCleanup({
        memberId: "member-1",
        sessionId: "wrong-session",
        operationId: "launch-1",
      }),
    ).resolves.toBeNull();
    const before = (await db.execute(sql`
			SELECT launch_cleanup_requested_at
			FROM team_members
			WHERE id = 'member-1'
		`)) as Array<{ launch_cleanup_requested_at: Date | null }>;
    expect(before[0].launch_cleanup_requested_at).toBeNull();

    await expect(
      store.requestMemberLaunchCleanup({
        memberId: "member-1",
        sessionId: "child-1",
        operationId: "launch-1",
      }),
    ).resolves.toEqual({ action: "unwind" });
    const after = (await db.execute(sql`
			SELECT launch_cleanup_requested_at
			FROM team_members
			WHERE id = 'member-1'
		`)) as Array<{ launch_cleanup_requested_at: Date | null }>;
    expect(after[0].launch_cleanup_requested_at).not.toBeNull();
  });

  it("does not stamp a child stop after promotion already won the launch locks", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug)
			VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, agent_version, status,
				workflow_execution_id
			) VALUES (
				'lead-1', 'user-1', 'proj-1', 'worker-agent', 1, 'running', ${EXEC}
			)
		`);
    await db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
			VALUES ('team-1', ${EXEC}, 'proj-1', 'team', 'lead-1')
		`);
    const reservation = await store.beginMemberSpawn({
      teamId: "team-1",
      sessionId: "child-1",
      name: "worker",
      dispatchRecipe: launchRecipe("child-1"),
    });
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, agent_version, status,
				workflow_execution_id, parent_execution_id, dapr_instance_id,
				runtime_app_id
			) VALUES (
				'child-1', 'user-1', 'proj-1', 'worker-agent', 1, 'rescheduling',
				${EXEC}, 'lead-1', 'child-1', 'agent-session-child-1'
			)
		`);
    const launch = {
      memberId: reservation!.member.id,
      sessionId: "child-1",
      operationId: reservation!.member.launch_operation_id!,
    };

    await expect(store.promoteStartingMember(launch)).resolves.toBe(true);
    await expect(store.requestMemberLaunchCleanup(launch)).resolves.toBeNull();
    const [child] = (await db.execute(sql`
			SELECT stop_requested_at, stop_requested_mode
			FROM sessions
			WHERE id = 'child-1'
		`)) as Array<{
      stop_requested_at: Date | null;
      stop_requested_mode: string | null;
    }>;
    expect(child).toEqual({
      stop_requested_at: null,
      stop_requested_mode: null,
    });
  });

  it("never claims or purges a foreign global session identity", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug)
			VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, agent_version, status,
				workflow_execution_id
			) VALUES
				('lead-1', 'user-1', 'proj-1', 'worker-agent', 1, 'running', ${EXEC}),
				('foreign-existing', 'other-user', 'other-project', 'worker-agent', 1, 'running', NULL)
		`);
    await db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
			VALUES ('team-1', ${EXEC}, 'proj-1', 'team', 'lead-1')
		`);

    await expect(
      store.beginMemberSpawn({
        teamId: "team-1",
        sessionId: "foreign-existing",
        name: "blocked-worker",
        dispatchRecipe: launchRecipe("foreign-existing"),
      }),
    ).resolves.toBeNull();
    expect(await store.getMemberByName("team-1", "blocked-worker")).toBeNull();

    const raced = await store.beginMemberSpawn({
      teamId: "team-1",
      sessionId: "foreign-race",
      name: "raced-worker",
      dispatchRecipe: launchRecipe("foreign-race"),
    });
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, agent_version, status
			) VALUES (
				'foreign-race', 'other-user', 'other-project', 'worker-agent', 1, 'running'
			)
		`);
    const racedLaunch = {
      memberId: raced!.member.id,
      sessionId: "foreign-race",
      operationId: raced!.member.launch_operation_id!,
    };
    await expect(
      store.requestMemberLaunchCleanup(racedLaunch),
    ).resolves.toEqual({ action: "unwind" });
    await expect(store.completeMemberLaunchCleanup(racedLaunch)).resolves.toBe(
      true,
    );

    const owned = await store.beginMemberSpawn({
      teamId: "team-1",
      sessionId: "owned-child",
      name: "owned-worker",
      dispatchRecipe: launchRecipe("owned-child"),
    });
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, agent_version, status,
				workflow_execution_id, parent_execution_id
			) VALUES (
				'owned-child', 'user-1', 'proj-1', 'worker-agent', 1, 'rescheduling',
				${EXEC}, 'lead-1'
			)
		`);
    await expect(
      store.requestMemberLaunchCleanup({
        memberId: owned!.member.id,
        sessionId: "owned-child",
        operationId: owned!.member.launch_operation_id!,
      }),
    ).resolves.toEqual({ action: "purge" });
  });

  it("downgrades a persisted purge when the exact child is replaced by a foreign session", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug)
			VALUES
				('worker-agent', 'Worker', 'worker-agent'),
				('foreign-agent', 'Foreign', 'foreign-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, agent_version, status,
				workflow_execution_id, parent_execution_id
			) VALUES (
				'lead-1', 'user-1', 'proj-1', 'worker-agent', 1, 'running',
				${EXEC}, NULL
			)
		`);
    await db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
			VALUES ('team-1', ${EXEC}, 'proj-1', 'team', 'lead-1')
		`);
    const reservation = await store.beginMemberSpawn({
      teamId: "team-1",
      sessionId: "reused-child",
      name: "worker",
      dispatchRecipe: launchRecipe("reused-child"),
    });
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, agent_version, status,
				workflow_execution_id, parent_execution_id, dapr_instance_id,
				runtime_app_id
			) VALUES (
				'reused-child', 'user-1', 'proj-1', 'worker-agent', 1,
				'rescheduling', ${EXEC}, 'lead-1', 'owned-generation',
				'agent-session-owned-generation'
			)
		`);
    await db.execute(sql`
			UPDATE team_members
			SET launch_started_at = now() - interval '2 minutes'
			WHERE id = ${reservation!.member.id}
		`);

    const launch = {
      memberId: reservation!.member.id,
      sessionId: "reused-child",
      operationId: reservation!.member.launch_operation_id!,
    };
    await expect(store.requestMemberLaunchCleanup(launch)).resolves.toEqual({
      action: "purge",
    });
    const [ownedStop] = (await db.execute(sql`
			SELECT stop_requested_at, stop_requested_mode
			FROM sessions
			WHERE id = 'reused-child'
		`)) as Array<{
      stop_requested_at: Date | null;
      stop_requested_mode: string | null;
    }>;
    expect(ownedStop.stop_requested_at).not.toBeNull();
    expect(ownedStop.stop_requested_mode).toBe("purge");
    await expect(store.completeMemberLaunchCleanup(launch)).resolves.toBe(
      false,
    );
    expect(await store.getMemberByName("team-1", "worker")).not.toBeNull();

    await db.execute(sql`DELETE FROM sessions WHERE id = 'reused-child'`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, agent_version, status,
				dapr_instance_id, runtime_app_id
			) VALUES (
				'reused-child', 'foreign-user', 'foreign-project', 'foreign-agent', 9,
				'running', 'foreign-generation', 'agent-session-foreign-generation'
			)
		`);

    const lifecycle = {
      stopSession: vi.fn(async () => ({
        confirmed: true,
        state: "confirmed",
      })),
    };
    const result = await reconcileTeamMemberLaunches(
      { teams: store, lifecycle, now: Date.now },
      {
        dryRun: false,
        limit: 10,
        maxActionsPerRun: 10,
        staleSeconds: 60,
      },
    );

    expect(lifecycle.stopSession).not.toHaveBeenCalled();
    expect(result.decisions).toEqual([
      expect.objectContaining({
        action: "cleanup_completed",
        executed: true,
      }),
    ]);
    expect(await store.getMemberByName("team-1", "worker")).toBeNull();
    const [foreign] = (await db.execute(sql`
			SELECT stop_requested_at, stop_requested_mode
			FROM sessions
			WHERE id = 'reused-child'
		`)) as Array<{
      stop_requested_at: Date | null;
      stop_requested_mode: string | null;
    }>;
    expect(foreign).toEqual({
      stop_requested_at: null,
      stop_requested_mode: null,
    });
  });

  it("repairs a new-spawn crash only for the scanned published runtime generation", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug)
			VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, status, workflow_execution_id
			) VALUES ('lead-1', 'user-1', 'proj-1', 'worker-agent', 'running', ${EXEC})
		`);
    await db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
			VALUES ('team-1', ${EXEC}, 'proj-1', 'team', 'lead-1')
		`);
    const reservation = await store.beginMemberSpawn({
      teamId: "team-1",
      sessionId: "child-1",
      name: "worker",
      dispatchRecipe: launchRecipe("child-1"),
    });
    const member = reservation?.member;
    expect(member?.launch_operation_id).toBeTruthy();
    await db.execute(sql`
			UPDATE team_members
			SET launch_started_at = now() - interval '2 minutes'
			WHERE id = ${member!.id}
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, agent_version, status, workflow_execution_id,
				parent_execution_id, dapr_instance_id, runtime_app_id
			) VALUES (
				'child-1', 'user-1', 'proj-1', 'worker-agent', 1, 'rescheduling', ${EXEC},
				'lead-1', 'child-1', 'agent-session-child-1-g2'
			)
		`);

    const [launch] = await store.listStaleMemberLaunches({
      staleBefore: new Date(),
      limit: 10,
    });
    expect(launch).toMatchObject({
      memberId: member!.id,
      operationId: member!.launch_operation_id,
      runtimeAppId: "agent-session-child-1-g2",
      daprInstanceId: "child-1",
    });
    await expect(
      store.reconcileStaleMemberLaunch({
        ...launch,
        runtimeAppId: "agent-session-child-1-g1",
      }),
    ).resolves.toEqual({ status: "stale" });
    await expect(
      store.reconcileStaleMemberLaunch({
        ...launch,
        daprInstanceId: "child-1--older-generation",
      }),
    ).resolves.toEqual({ status: "stale" });
    expect((await store.getMemberByName("team-1", "worker"))?.status).toBe(
      "starting",
    );

    await expect(store.reconcileStaleMemberLaunch(launch)).resolves.toEqual({
      status: "promoted",
    });
    expect((await store.getMemberByName("team-1", "worker"))?.status).toBe(
      "working",
    );
  });

  it("repairs a revival crash by restoring the exact persisted predecessor", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug)
			VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, status, workflow_execution_id
			) VALUES ('lead-1', 'user-1', 'proj-1', 'worker-agent', 'running', ${EXEC})
		`);
    await db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
			VALUES ('team-1', ${EXEC}, 'proj-1', 'team', 'lead-1')
		`);
    await db.execute(sql`
			INSERT INTO team_members (id, team_id, session_id, name, role, status)
			VALUES ('member-1', 'team-1', 'old-1', 'worker', 'member', 'shutdown')
		`);
    const reservation = await store.beginMemberRevival({
      teamId: "team-1",
      memberId: "member-1",
      previousSessionId: "old-1",
      previousStatus: "shutdown",
      sessionId: "child-1",
      dispatchRecipe: launchRecipe("child-1"),
    });
    const revival = reservation?.member;
    await db.execute(sql`
			UPDATE team_members
			SET launch_started_at = now() - interval '2 minutes'
			WHERE id = 'member-1'
		`);
    const [launch] = await store.listStaleMemberLaunches({
      staleBefore: new Date(),
      limit: 10,
    });
    expect(launch).toMatchObject({
      kind: "revival",
      previousSessionId: "old-1",
      previousStatus: "shutdown",
      operationId: revival!.launch_operation_id,
    });

    await expect(store.reconcileStaleMemberLaunch(launch)).resolves.toEqual({
      status: "cleanup",
      action: "unwind",
    });
    await expect(
      store.completeMemberLaunchCleanup({
        memberId: "member-1",
        sessionId: "child-1",
        operationId: "wrong-operation",
      }),
    ).resolves.toBe(false);
    await expect(
      store.completeMemberLaunchCleanup({
        memberId: "member-1",
        sessionId: "child-1",
        operationId: launch.operationId,
      }),
    ).resolves.toBe(true);
    expect(await store.getMemberByName("team-1", "worker")).toMatchObject({
      session_id: "old-1",
      status: "shutdown",
      launch_operation_id: null,
      launch_dispatch_recipe: null,
    });
  });

  it("leaves every owned provisioning lease to the runtime reconciler", async () => {
    await db.execute(sql`
			INSERT INTO agents (id, name, slug)
			VALUES ('worker-agent', 'Worker', 'worker-agent')
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, status, workflow_execution_id
			) VALUES ('lead-1', 'user-1', 'proj-1', 'worker-agent', 'running', ${EXEC})
		`);
    await db.execute(sql`
			INSERT INTO teams (id, workflow_execution_id, project_id, name, lead_session_id)
			VALUES ('team-1', ${EXEC}, 'proj-1', 'team', 'lead-1')
		`);
    const reservation = await store.beginMemberSpawn({
      teamId: "team-1",
      sessionId: "child-1",
      name: "worker",
      dispatchRecipe: launchRecipe("child-1"),
    });
    const member = reservation?.member;
    await db.execute(sql`
			UPDATE team_members
			SET launch_started_at = now() - interval '12 minutes'
			WHERE id = ${member!.id}
		`);
    await db.execute(sql`
			INSERT INTO sessions (
				id, user_id, project_id, agent_id, agent_version, status, workflow_execution_id,
				parent_execution_id, runtime_provisioning_started_at
			) VALUES (
				'child-1', 'user-1', 'proj-1', 'worker-agent', 1, 'rescheduling', ${EXEC},
				'lead-1', now() - interval '11 minutes'
			)
		`);
    const [launch] = await store.listStaleMemberLaunches({
      staleBefore: new Date(),
      limit: 10,
    });

    await expect(store.reconcileStaleMemberLaunch(launch)).resolves.toEqual({
      status: "pending",
    });
    expect(
      (await store.getMemberByName("team-1", "worker"))
        ?.launch_cleanup_requested_at,
    ).toBeNull();

    // Once the runtime reconciler releases its exact lease, team recovery owns
    // the remaining unpublished member reservation.
    await db.execute(sql`
				UPDATE sessions
				SET runtime_provisioning_started_at = NULL
				WHERE id = 'child-1'
			`);
    const [releasedLaunch] = await store.listStaleMemberLaunches({
      staleBefore: new Date(),
      limit: 10,
    });
    await expect(
      store.reconcileStaleMemberLaunch(releasedLaunch),
    ).resolves.toEqual({
      status: "cleanup",
      action: "purge",
    });
  });

	it("ensureTeamRunExecution ADOPTS the lead's existing execution", async () => {
		const lead = `dsw-team-lead-${EXEC}`;
		await store.ensureScriptLeadSession({
			sessionId: lead,
			userId: "user-1",
			projectId: "proj-1",
			executionId: EXEC,
		});
    await ensureTeam(
      { teamId: `team-${EXEC}`, leadSessionId: lead, projectId: "proj-1" },
      store,
    );
		const execId = await ensureTeamRunExecution(
			{ teamId: `team-${EXEC}`, projectId: "proj-1", leadSessionId: lead },
			store,
		);
		expect(execId).toBe(EXEC); // adopted, not synthesized
		expect(await store.getTeamExecutionId(`team-${EXEC}`)).toBe(EXEC);
		// No synthetic execution row appeared.
		const execs = (await db.execute(
			sql`SELECT count(*)::int AS n FROM workflow_executions`,
		)) as Array<{ n: number }>;
		expect(Number(execs[0].n)).toBe(1);
	});

	it("refreshTeamRunStatus refuses to touch a non-team-run execution", async () => {
		const lead = `dsw-team-lead-${EXEC}`;
		await store.ensureScriptLeadSession({
			sessionId: lead,
			userId: "user-1",
			projectId: "proj-1",
			executionId: EXEC,
		});
    await ensureTeam(
      { teamId: `team-${EXEC}`, leadSessionId: lead, projectId: "proj-1" },
      store,
    );
		await store.setTeamExecutionId(`team-${EXEC}`, EXEC);
		// One completed task + zero working members would reduce to success —
		// but the adopted execution is engine dynamic-script, so NOTHING changes.
    await store.createTask({
      teamId: `team-${EXEC}`,
      title: "done",
      status: "in_progress",
    });
		await db.execute(
			sql.raw(`UPDATE team_tasks SET status='completed', completed_at=now()`),
		);
		await store.refreshTeamRunStatus(`team-${EXEC}`);
		const rows = (await db.execute(
			sql`SELECT status, progress FROM workflow_executions WHERE id = ${EXEC}`,
		)) as Array<{ status: string; progress: number }>;
		expect(rows[0].status).toBe("running"); // untouched
	});

	it("refreshTeamRunStatus still reduces a synthetic team-run execution", async () => {
		await db.execute(sql`
			INSERT INTO workflow_executions (id, user_id, project_id, status, execution_ir)
			VALUES ('synth-1', 'user-1', 'proj-1', 'running', '{"engine":"team-run"}'::jsonb)
		`);
    await ensureTeam(
      { teamId: "team-x", leadSessionId: "lead-x", projectId: "proj-1" },
      store,
    );
		await store.setTeamExecutionId("team-x", "synth-1");
    await store.addMember({
      teamId: "team-x",
      sessionId: "m-1",
      name: "worker",
    });
    await db.execute(
      sql`UPDATE team_members SET status = 'idle' WHERE session_id = 'm-1'`,
    );
		const t = await store.createTask({ teamId: "team-x", title: "only" });
		await store.completeTask({ teamId: "team-x", taskId: t.id });
		await store.refreshTeamRunStatus("team-x");
		const rows = (await db.execute(
			sql`SELECT status, progress FROM workflow_executions WHERE id = 'synth-1'`,
		)) as Array<{ status: string; progress: number }>;
		expect(rows[0].status).toBe("success");
		expect(Number(rows[0].progress)).toBe(100);
	});
});

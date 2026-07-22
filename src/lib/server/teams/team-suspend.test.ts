/**
 * Suspend-on-idle tick against real PGlite (candidate SQL + status writes) with
 * the kube patch mocked. Pins: threshold/lead/terminal gating, claimable-work
 * skip, desired-state ownership before the patch, compensation, and
 * tick idempotency via the deterministic audit sourceEventId.
 */

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPgliteDb } from "$lib/server/db/pglite-compat";
import { PostgresTeamStore } from "$lib/server/application/adapters/team-store";
import type { TeamStore } from "$lib/server/application/ports";
import {
  deliverTeamMessages,
  type TeamDeliveryDeps,
} from "$lib/server/teams/team-delivery";
import {
  runTeamSuspendTick,
  type TeamSuspendDeps,
} from "$lib/server/teams/team-suspend";

type Pglite = ReturnType<typeof createPgliteDb>["db"];

async function fresh(): Promise<{ db: Pglite; store: TeamStore }> {
	const { db } = createPgliteDb();
	await db.execute(
		sql.raw(
      `CREATE TABLE team_members (id text primary key, team_id text not null, session_id text unique not null, agent_slug text, name text not null, role text default 'member', model text, status text default 'working', plan_mode_required boolean default false, joined_at timestamp default now(), updated_at timestamp default now(), runtime_operation_id text, runtime_operation text, runtime_operation_started_at timestamp, runtime_desired_running boolean default true not null)`,
		),
	);
	await db.execute(
		sql.raw(
			`CREATE TABLE team_tasks (id text primary key, team_id text not null, title text not null, description text, status text default 'pending', assignee_session_id text, depends_on jsonb default '[]'::jsonb, created_by_session_id text, created_at timestamp default now(), updated_at timestamp default now(), completed_at timestamp, completion_note text)`,
		),
	);
	await db.execute(
		sql.raw(
      `CREATE TABLE sessions (id text primary key, status text default 'idle', stop_requested_at timestamp, dapr_instance_id text, runtime_app_id text, runtime_sandbox_name text, last_event_at timestamp)`,
    ),
  );
  await db.execute(
    sql.raw(
      `CREATE TABLE session_events (id text primary key, session_id text not null, type text not null, data jsonb default '{}'::jsonb, processed_at timestamp)`,
		),
	);
	return { db, store: new PostgresTeamStore(() => db as never) };
}

async function seedMember(
	db: Pglite,
	input: {
		sessionId: string;
		role?: string;
		memberStatus?: string;
		sessionStatus?: string;
		daprInstanceId?: string | null;
		idleForSeconds?: number;
		sandboxName?: string | null;
	},
): Promise<void> {
	await db.execute(sql`
		INSERT INTO team_members (id, team_id, session_id, name, role, status, updated_at)
		VALUES (${`m-${input.sessionId}`}, 't1', ${input.sessionId}, ${input.sessionId},
		        ${input.role ?? "member"}, ${input.memberStatus ?? "idle"},
		        now() - make_interval(secs => ${input.idleForSeconds ?? 3600}))
	`);
	await db.execute(sql`
		INSERT INTO sessions (id, status, dapr_instance_id, runtime_sandbox_name, last_event_at)
		VALUES (${input.sessionId}, ${input.sessionStatus ?? "idle"},
		        ${input.daprInstanceId === undefined ? "wf-1" : input.daprInstanceId},
		        ${input.sandboxName === undefined ? `agent-host-${input.sessionId}` : input.sandboxName},
		        now() - make_interval(secs => ${input.idleForSeconds ?? 3600}))
	`);
}

function makeDeps(result: "patched" | "missing" | Error = "patched") {
  const appended: Array<{ sessionId: string; sourceEventId?: string | null }> =
    [];
	const deps: TeamSuspendDeps = {
    runtimeHost: {
      suspend: vi.fn(async () => {
			if (result instanceof Error) throw result;
			return result;
		}),
      resume: vi.fn(async () => "patched" as const),
      getPodStatus: vi.fn(async () => ({
        presence: "absent" as const,
        exited: false,
      })),
      getSandboxState: vi.fn(async () => ({ presence: "absent" as const })),
      deleteExitedPods: vi.fn(async () => []),
      waitUntilReady: vi.fn(async () => undefined),
    },
		appendSessionEvent: vi.fn(async (sessionId, event) => {
			appended.push({ sessionId, sourceEventId: event.sourceEventId });
			return {};
		}),
	};
	return { deps, appended };
}

async function memberStatus(db: Pglite, sessionId: string): Promise<string> {
	const r = (await db.execute(
		sql`SELECT status FROM team_members WHERE session_id = ${sessionId}`,
	)) as Array<{ status: string }>;
	return r[0]?.status ?? "<gone>";
}

async function runtimeIntent(
  db: Pglite,
  sessionId: string,
): Promise<{
  operation: string | null;
  desiredRunning: boolean;
}> {
  const r = (await db.execute(sql`
		SELECT runtime_operation, runtime_desired_running
		FROM team_members
		WHERE session_id = ${sessionId}
	`)) as Array<{
    runtime_operation: string | null;
    runtime_desired_running: boolean;
  }>;
  return {
    operation: r[0]?.runtime_operation ?? null,
    desiredRunning: r[0]?.runtime_desired_running ?? true,
  };
}

describe("runTeamSuspendTick", () => {
	beforeEach(() => {
		process.env.TEAM_SUSPEND_ENABLED = "true";
		process.env.TEAM_SUSPEND_IDLE_SECONDS = "900";
	});
	afterEach(() => {
		delete process.env.TEAM_SUSPEND_ENABLED;
		delete process.env.TEAM_SUSPEND_IDLE_SECONDS;
	});

	it("does nothing when the gate is off", async () => {
		process.env.TEAM_SUSPEND_ENABLED = "false";
		const { deps } = makeDeps();
		// A poisoned store proves the gate short-circuits before any query.
		const store = new Proxy({} as TeamStore, {
			get: () => {
				throw new Error("store must not be touched");
			},
		});
    expect(await runTeamSuspendTick(store, deps)).toEqual({
      suspended: 0,
      skipped: 0,
    });
	});

  it("claims desired-suspended before patching, then finalizes member status", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
		const { deps, appended } = makeDeps();
    vi.mocked(deps.runtimeHost.suspend).mockImplementationOnce(async () => {
      expect(await memberStatus(db, "s1")).toBe("idle");
      expect(await runtimeIntent(db, "s1")).toEqual({
        operation: "suspend",
        desiredRunning: false,
      });
      return "patched";
    });

		const r = await runTeamSuspendTick(store, deps);
		expect(r).toEqual({ suspended: 1, skipped: 0 });
    expect(deps.runtimeHost.suspend).toHaveBeenCalledWith("agent-host-s1");
		expect(await memberStatus(db, "s1")).toBe("suspended");
    expect(await runtimeIntent(db, "s1")).toEqual({
      operation: null,
      desiredRunning: false,
    });
		expect(appended[0].sourceEventId).toMatch(/^host-suspend:s1:/);
	});

  it("allows only one concurrent tick to patch a candidate", async () => {
    const { db, store } = await fresh();
    await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
    const { deps } = makeDeps();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(deps.runtimeHost.suspend).mockImplementationOnce(async () => {
      entered();
      await releasePromise;
      return "patched";
    });

    const first = runTeamSuspendTick(store, deps);
    await enteredPromise;
    const second = await runTeamSuspendTick(store, deps);
    release();

    expect(await first).toEqual({ suspended: 1, skipped: 0 });
    expect(second).toEqual({ suspended: 0, skipped: 1 });
    expect(deps.runtimeHost.suspend).toHaveBeenCalledTimes(1);
    expect(deps.runtimeHost.resume).not.toHaveBeenCalled();
  });

	it("skips: under threshold, lead, terminal session, unspawned session", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "fresh", idleForSeconds: 60 });
    await seedMember(db, {
      sessionId: "lead1",
      role: "lead",
      idleForSeconds: 3600,
    });
    await seedMember(db, {
      sessionId: "dead",
      sessionStatus: "terminated",
      idleForSeconds: 3600,
    });
    await seedMember(db, {
      sessionId: "unspawned",
      daprInstanceId: null,
      idleForSeconds: 3600,
    });
		const { deps } = makeDeps();

		const r = await runTeamSuspendTick(store, deps);
		expect(r).toEqual({ suspended: 0, skipped: 0 }); // none even candidates
    expect(deps.runtimeHost.suspend).not.toHaveBeenCalled();
	});

	it("skips a member whose team has claimable work (nudge path owns it)", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
		await db.execute(
      sql.raw(
        `INSERT INTO team_tasks (id, team_id, title) VALUES ('t-1','t1','todo')`,
      ),
		);
		const { deps } = makeDeps();

		const r = await runTeamSuspendTick(store, deps);
		expect(r).toEqual({ suspended: 0, skipped: 1 });
    expect(deps.runtimeHost.suspend).not.toHaveBeenCalled();
		expect(await memberStatus(db, "s1")).toBe("idle");
	});

	it("missing CR: skips without writing suspended", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
		const { deps } = makeDeps("missing");

		const r = await runTeamSuspendTick(store, deps);
		expect(r).toEqual({ suspended: 0, skipped: 1 });
		expect(await memberStatus(db, "s1")).toBe("idle");
    expect(await runtimeIntent(db, "s1")).toEqual({
      operation: null,
      desiredRunning: true,
    });
	});

	it("patch failure: skips, leaves status idle for the next tick", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
		const { deps } = makeDeps(new Error("kube down"));

		const r = await runTeamSuspendTick(store, deps);
		expect(r).toEqual({ suspended: 0, skipped: 1 });
		expect(await memberStatus(db, "s1")).toBe("idle");
    expect(deps.runtimeHost.resume).toHaveBeenCalledWith("agent-host-s1");
  });

  it("does not resume when stop intent lands before a failing suspend returns", async () => {
    const { db, store } = await fresh();
    await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
    const { deps } = makeDeps();
    vi.mocked(deps.runtimeHost.suspend).mockImplementationOnce(async () => {
      await db.execute(sql`
				UPDATE sessions SET stop_requested_at = now() WHERE id = 's1'
			`);
      throw new Error("connection reset after patch");
    });

    expect(await runTeamSuspendTick(store, deps)).toEqual({
      suspended: 0,
      skipped: 1,
    });
    expect(deps.runtimeHost.resume).not.toHaveBeenCalled();
    expect(await memberStatus(db, "s1")).toBe("idle");
    expect(await runtimeIntent(db, "s1")).toEqual({
      operation: null,
      desiredRunning: false,
    });
	});

	it("second tick is a no-op (suspended members are not candidates)", async () => {
		const { db, store } = await fresh();
		await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
		const { deps } = makeDeps();
		await runTeamSuspendTick(store, deps);
		const again = await runTeamSuspendTick(store, deps);
		expect(again).toEqual({ suspended: 0, skipped: 0 });
    expect(deps.runtimeHost.suspend).toHaveBeenCalledTimes(1);
		expect(await memberStatus(db, "s1")).toBe("suspended");
	});

	it("uses the session's persisted runtime_sandbox_name when present", async () => {
		const { db, store } = await fresh();
		await seedMember(db, {
			sessionId: "s1",
			idleForSeconds: 3600,
			sandboxName: "agent-host-custom-name",
		});
		const { deps } = makeDeps();
		await runTeamSuspendTick(store, deps);
    expect(deps.runtimeHost.suspend).toHaveBeenCalledWith(
      "agent-host-custom-name",
    );
  });

  it("does not counteract lifecycle cleanup when stop intent races the patch", async () => {
    const { db, store } = await fresh();
    await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
    const { deps } = makeDeps();
    vi.mocked(deps.runtimeHost.suspend).mockImplementationOnce(async () => {
      await db.execute(sql`
				UPDATE sessions SET stop_requested_at = now() WHERE id = 's1'
			`);
      return "patched";
    });

    const result = await runTeamSuspendTick(store, deps);

    expect(result).toEqual({ suspended: 0, skipped: 1 });
    expect(deps.runtimeHost.resume).not.toHaveBeenCalled();
    expect(await memberStatus(db, "s1")).toBe("idle");
    expect(deps.appendSessionEvent).not.toHaveBeenCalled();
  });

  it("does not suspend underneath a delivery that owns desired-running", async () => {
    const { db, store } = await fresh();
    await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
    const suspend = makeDeps();
    let enteredProbe!: () => void;
    let releaseProbe!: () => void;
    const probeEntered = new Promise<void>((resolve) => {
      enteredProbe = resolve;
    });
    const probeReleased = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const delivery: TeamDeliveryDeps = {
      store,
      runtimeHost: {
        getPodStatus: vi.fn(async () => {
          enteredProbe();
          await probeReleased;
          return { presence: "present" as const, exited: false };
        }),
        getSandboxState: vi.fn(async () => ({
          presence: "present" as const,
          desiredRunning: true,
        })),
        deleteExitedPods: vi.fn(async () => []),
        suspend: vi.fn(async () => "patched" as const),
        resume: vi.fn(async () => "patched" as const),
        waitUntilReady: vi.fn(async () => undefined),
      },
		claimUnraisedTeamEvents: vi.fn(async () => [
			{ id: "event-1", sequence: 1, data: { type: "user.message" } },
		]),
		hasUnprocessedTeamEvents: vi.fn(async () => true),
		completeTeamEventDelivery: vi.fn(async () => 1),
			releaseTeamEventDeliveryClaim: vi.fn(async () => 1),
			newClaimToken: () => "claim-1",
      ensurePublishedRuntimeHost: vi.fn(async () => ({ recovered: true })),
			raiseSessionUserEvents: vi.fn(async (_sessionId, _events, delivery) => ({
				accepted: true as const,
				deliveryId: delivery.batchId,
			})),
      appendSessionEvent: vi.fn(async () => ({})),
    };

    const delivering = deliverTeamMessages("s1", delivery);
    await probeEntered;
    expect(await runtimeIntent(db, "s1")).toEqual({
      operation: "delivery",
      desiredRunning: true,
    });

    expect(await runTeamSuspendTick(store, suspend.deps)).toEqual({
      suspended: 0,
      skipped: 1,
    });
    expect(suspend.deps.runtimeHost.suspend).not.toHaveBeenCalled();

    releaseProbe();
    expect(await delivering).toBe("delivered");
    expect(await memberStatus(db, "s1")).toBe("working");
    expect(await runtimeIntent(db, "s1")).toEqual({
      operation: null,
      desiredRunning: true,
    });
  });

  it("finishes suspension before delivery can revive and raise", async () => {
    const { db, store } = await fresh();
    await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
    const events: string[] = [];
    const suspend = makeDeps();
    let enteredSuspend!: () => void;
    let releaseSuspend!: () => void;
    const suspendEntered = new Promise<void>((resolve) => {
      enteredSuspend = resolve;
    });
    const suspendReleased = new Promise<void>((resolve) => {
      releaseSuspend = resolve;
    });
    vi.mocked(suspend.deps.runtimeHost.suspend).mockImplementationOnce(
      async () => {
        events.push("suspend-enter");
        enteredSuspend();
        await suspendReleased;
        events.push("suspend-finish");
        return "patched";
      },
    );
    const delivery: TeamDeliveryDeps = {
      store,
      runtimeHost: {
        getPodStatus: vi.fn(async () => ({
          presence: "absent" as const,
          exited: false,
        })),
        getSandboxState: vi.fn(async () => ({
          presence: "present" as const,
          desiredRunning: false,
        })),
        deleteExitedPods: vi.fn(async () => []),
        suspend: vi.fn(async () => "patched" as const),
        resume: vi.fn(async () => {
          events.push("resume");
          return "patched" as const;
        }),
        waitUntilReady: vi.fn(async () => undefined),
      },
		claimUnraisedTeamEvents: vi.fn(async () => [
			{ id: "event-1", sequence: 1, data: { type: "user.message" } },
		]),
		hasUnprocessedTeamEvents: vi.fn(async () => true),
		completeTeamEventDelivery: vi.fn(async () => 1),
			releaseTeamEventDeliveryClaim: vi.fn(async () => 1),
			newClaimToken: () => "claim-1",
      ensurePublishedRuntimeHost: vi.fn(async () => ({ recovered: true })),
			raiseSessionUserEvents: vi.fn(async (_sessionId, _events, delivery) => {
        events.push("raise");
				return { accepted: true as const, deliveryId: delivery.batchId };
      }),
      appendSessionEvent: vi.fn(async () => ({})),
    };

    const suspending = runTeamSuspendTick(store, suspend.deps);
    await suspendEntered;
    expect(await runtimeIntent(db, "s1")).toEqual({
      operation: "suspend",
      desiredRunning: false,
    });
    expect(await deliverTeamMessages("s1", delivery)).toBe("retry");
    expect(delivery.claimUnraisedTeamEvents).not.toHaveBeenCalled();
    expect(delivery.runtimeHost.resume).not.toHaveBeenCalled();

    releaseSuspend();
    expect(await suspending).toEqual({ suspended: 1, skipped: 0 });
    expect(await deliverTeamMessages("s1", delivery)).toBe("delivered");
    expect(events).toEqual([
      "suspend-enter",
      "suspend-finish",
      "resume",
      "raise",
    ]);
    expect(await memberStatus(db, "s1")).toBe("working");
  });

  it("recovers a stale same-intent lease with an exact new token", async () => {
    const { db, store } = await fresh();
    await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
    const first = await store.claimRuntimeOperation({
      sessionId: "s1",
      operation: "delivery",
      staleAfterSeconds: 300,
    });
    expect(first).not.toBeNull();
    await db.execute(sql`
			UPDATE team_members
			SET runtime_operation_started_at = now() - interval '10 minutes'
			WHERE session_id = 's1'
		`);

    const recovered = await store.claimRuntimeOperation({
      sessionId: "s1",
      operation: "delivery",
      staleAfterSeconds: 300,
    });
    expect(recovered).not.toBeNull();
    expect(recovered?.operationId).not.toBe(first?.operationId);
    expect(
      await store.verifyRuntimeOperation({
        sessionId: "s1",
        operationId: first!.operationId,
        operation: "delivery",
        desiredRunning: true,
      }),
    ).toBe(false);
    expect(
      await store.verifyRuntimeOperation({
        sessionId: "s1",
        operationId: recovered!.operationId,
        operation: "delivery",
        desiredRunning: true,
      }),
    ).toBe(true);
  });

  it("lets queued work take over a stale suspend lease with a new exact token", async () => {
    const { db, store } = await fresh();
    await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
    const suspended = await store.claimRuntimeOperation({
      sessionId: "s1",
      operation: "suspend",
      staleAfterSeconds: 300,
    });
    expect(suspended).not.toBeNull();
    await db.execute(sql`
			UPDATE team_members
			SET runtime_operation_started_at = now() - interval '10 minutes'
			WHERE session_id = 's1'
		`);
    await db.execute(sql`
			INSERT INTO session_events (id, session_id, type, data)
			VALUES (
				'event-after-suspend-crash',
				's1',
				'user.message',
				'{"origin":"teammate-message"}'::jsonb
			)
		`);

    const delivery = await store.claimRuntimeOperation({
      sessionId: "s1",
      operation: "delivery",
      staleAfterSeconds: 300,
    });

    expect(delivery).not.toBeNull();
    expect(delivery?.operationId).not.toBe(suspended?.operationId);
    expect(delivery?.desiredRunning).toBe(true);
    expect(
      await store.verifyRuntimeOperation({
        sessionId: "s1",
        operationId: suspended!.operationId,
        operation: "suspend",
        desiredRunning: false,
      }),
    ).toBe(false);
    expect(
      await store.verifyRuntimeOperation({
        sessionId: "s1",
        operationId: delivery!.operationId,
        operation: "delivery",
        desiredRunning: true,
      }),
    ).toBe(true);
  });

  it("preserves terminal shutdown when it races the scale-to-zero patch", async () => {
    const { db, store } = await fresh();
    await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
    const { deps } = makeDeps();
    vi.mocked(deps.runtimeHost.suspend).mockImplementationOnce(async () => {
      await db.execute(sql`
				UPDATE team_members SET status = 'shutdown' WHERE session_id = 's1'
			`);
      return "patched";
    });

    const result = await runTeamSuspendTick(store, deps);

    expect(result).toEqual({ suspended: 0, skipped: 1 });
    expect(deps.runtimeHost.resume).not.toHaveBeenCalled();
    expect(await memberStatus(db, "s1")).toBe("shutdown");
    expect(deps.appendSessionEvent).not.toHaveBeenCalled();
  });

  it("keeps a successfully suspended host suspended when audit append fails", async () => {
    const { db, store } = await fresh();
    await seedMember(db, { sessionId: "s1", idleForSeconds: 3600 });
    const { deps } = makeDeps();
    vi.mocked(deps.appendSessionEvent).mockRejectedValueOnce(
      new Error("audit down"),
    );

    const result = await runTeamSuspendTick(store, deps);

    expect(result).toEqual({ suspended: 1, skipped: 0 });
    expect(await memberStatus(db, "s1")).toBe("suspended");
    expect(deps.runtimeHost.resume).not.toHaveBeenCalled();
	});
});

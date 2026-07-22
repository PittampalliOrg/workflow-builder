import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresWorkflowAgentRunStore } from "./postgres";

type SessionRow = {
	status: string;
	workflow_execution_id: string | null;
	dapr_instance_id: string | null;
	error_message: string | null;
	stop_reason: Record<string, unknown> | null;
	pending_input: Record<string, unknown> | null;
	completed_at: Date | null;
	updated_at: Date;
};

describe("PostgresWorkflowAgentRunStore terminal session convergence", () => {
	let client: PGlite;
	let store: PostgresWorkflowAgentRunStore;

	beforeEach(async () => {
		client = new PGlite();
		await client.exec(`
			CREATE TABLE workflow_agent_runs (
				id text PRIMARY KEY,
				workflow_execution_id text NOT NULL,
				agent_workflow_id text NOT NULL,
				dapr_instance_id text NOT NULL,
				workspace_ref text,
				status text NOT NULL,
				result jsonb,
				error text,
				completed_at timestamp,
				event_published_at timestamp,
				updated_at timestamp NOT NULL DEFAULT now()
			);
			CREATE TABLE sessions (
				id text PRIMARY KEY,
				status text NOT NULL,
				workflow_execution_id text,
				dapr_instance_id text,
				error_message text,
				stop_reason jsonb,
				pending_input jsonb,
				completed_at timestamp,
				updated_at timestamp NOT NULL DEFAULT now()
			);
			INSERT INTO workflow_agent_runs (
				id, workflow_execution_id, agent_workflow_id, dapr_instance_id, status
			) VALUES
				('run-failed', 'execution-1', 'session-failed', 'instance-failed', 'running'),
				('run-completed', 'execution-1', 'session-completed', 'instance-completed', 'running'),
				('run-running', 'execution-1', 'session-running', 'instance-running', 'scheduled'),
				('run-wrong-execution', 'execution-1', 'session-wrong-execution', 'instance-wrong-execution', 'running'),
				('run-wrong-instance', 'execution-1', 'session-wrong-instance', 'instance-correct', 'running'),
				('run-terminal-terminated', 'execution-1', 'session-terminal-terminated', 'instance-terminal-terminated', 'running'),
				('run-terminal-failed', 'execution-1', 'session-terminal-failed', 'instance-terminal-failed', 'running');
			INSERT INTO sessions (
				id, status, workflow_execution_id, dapr_instance_id,
				error_message, pending_input, completed_at, updated_at
			) VALUES
				('session-failed', 'rescheduling', 'execution-1', 'instance-failed',
				 null, '{"kind":"blocked"}', null, '2026-07-22T10:00:00Z'),
				('session-completed', 'running', 'execution-1', 'instance-completed',
				 null, '{"kind":"question"}', null, '2026-07-22T10:00:00Z'),
				('session-running', 'rescheduling', 'execution-1', 'instance-running',
				 null, '{"kind":"blocked"}', null, '2026-07-22T10:00:00Z'),
				('session-wrong-execution', 'running', 'execution-other', 'instance-wrong-execution',
				 null, '{"kind":"blocked"}', null, '2026-07-22T10:00:00Z'),
				('session-wrong-instance', 'running', 'execution-1', 'instance-replacement',
				 null, '{"kind":"blocked"}', null, '2026-07-22T10:00:00Z'),
				('session-terminal-terminated', 'terminated', 'execution-1', 'instance-terminal-terminated',
				 'stop won', '{"kind":"blocked"}', '2026-07-22T09:00:00Z', '2026-07-22T09:00:00Z'),
				('session-terminal-failed', 'failed', 'execution-1', 'instance-terminal-failed',
				 'crash won', '{"kind":"blocked"}', '2026-07-22T09:05:00Z', '2026-07-22T09:05:00Z');
		`);
		store = new PostgresWorkflowAgentRunStore(drizzle(client) as never);
	});

	afterEach(async () => {
		await client.close();
	});

	async function session(id: string): Promise<SessionRow> {
		const result = await client.query<SessionRow>(
			`SELECT status, workflow_execution_id, dapr_instance_id, error_message,
			        stop_reason,
			        pending_input, completed_at, updated_at
			 FROM sessions
			 WHERE id = $1`,
			[id],
		);
		return result.rows[0]!;
	}

	it("finalizes an exact linked session when the run fails before a terminal event", async () => {
		await expect(
			store.updateAgentRunLifecycle({
				id: "run-failed",
				status: "failed",
				error: "  start authority denied  ",
			}),
		).resolves.toEqual({ id: "run-failed", status: "failed" });

		const first = await session("session-failed");
		expect(first).toMatchObject({
			status: "failed",
			error_message: "start authority denied",
			stop_reason: {
				type: "crashed",
				message: "start authority denied",
			},
			pending_input: null,
		});
		expect(first.completed_at).toBeInstanceOf(Date);

		await store.updateAgentRunLifecycle({
			id: "run-failed",
			status: "failed",
			error: "replayed failure",
		});
		expect(await session("session-failed")).toEqual(first);
	});

	it("finalizes an exact linked session as terminated when the run completes", async () => {
		await store.updateAgentRunLifecycle({
			id: "run-completed",
			status: "completed",
			result: { content: "done" },
		});

		const row = await session("session-completed");
		expect(row).toMatchObject({
			status: "terminated",
			error_message: null,
			pending_input: null,
		});
		expect(row.completed_at).toBeInstanceOf(Date);
	});

	it("does not finalize the linked session for a nonterminal run transition", async () => {
		const before = await session("session-running");
		await store.updateAgentRunLifecycle({
			id: "run-running",
			status: "running",
			result: { phase: "started" },
		});
		expect(await session("session-running")).toEqual(before);
	});

	it("does not touch sessions whose execution or runtime instance no longer matches", async () => {
		const executionMismatch = await session("session-wrong-execution");
		const instanceMismatch = await session("session-wrong-instance");

		await store.updateAgentRunLifecycle({
			id: "run-wrong-execution",
			status: "failed",
			error: "must not escape execution lineage",
		});
		await store.updateAgentRunLifecycle({
			id: "run-wrong-instance",
			status: "completed",
		});

		expect(await session("session-wrong-execution")).toEqual(executionMismatch);
		expect(await session("session-wrong-instance")).toEqual(instanceMismatch);
	});

	it("keeps already-terminal projections sticky across terminal retries", async () => {
		const terminated = await session("session-terminal-terminated");
		const failed = await session("session-terminal-failed");

		await store.updateAgentRunLifecycle({
			id: "run-terminal-terminated",
			status: "failed",
			error: "late failure",
		});
		await store.updateAgentRunLifecycle({
			id: "run-terminal-failed",
			status: "completed",
		});
		await store.updateAgentRunLifecycle({
			id: "run-terminal-terminated",
			status: "failed",
			error: "second late failure",
		});

		expect(await session("session-terminal-terminated")).toEqual(terminated);
		expect(await session("session-terminal-failed")).toEqual(failed);
	});
});

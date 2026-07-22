import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkflowExecutionRuntimeHostIdentity } from "$lib/server/application/ports";
import { PostgresWorkflowExecutionRuntimeHostRepository } from "./execution-runtime-hosts";

const STARTED_AT = new Date("2026-07-22T12:00:00.000Z");
const STALE_BEFORE = new Date("2026-07-22T12:15:00.001Z");

function target(
	overrides: Partial<WorkflowExecutionRuntimeHostIdentity> = {},
): WorkflowExecutionRuntimeHostIdentity {
	return {
		executionId: "execution-1",
		purpose: "cli-workspace-command",
		helperSessionId: "execution-1__cliws",
		generationStartedAt: STARTED_AT,
		runtimeAppId: "agent-session-generation-one",
		runtimeInstanceId: "execution-1",
		runtimeSandboxName: "agent-host-agent-session-generation-one",
		owned: true,
		...overrides,
	};
}

describe("PostgresWorkflowExecutionRuntimeHostRepository", () => {
	let client: PGlite;
	let repository: PostgresWorkflowExecutionRuntimeHostRepository;

	beforeEach(async () => {
		client = new PGlite();
		await client.exec(`
			CREATE TABLE workflow_executions (
				id text PRIMARY KEY,
				status text NOT NULL,
				stop_requested_at timestamp
			);
			CREATE TABLE workflow_execution_runtime_hosts (
				workflow_execution_id text NOT NULL REFERENCES workflow_executions(id) ON DELETE RESTRICT,
				purpose text NOT NULL,
				helper_session_id text NOT NULL,
				generation_started_at timestamp NOT NULL,
				runtime_app_id text NOT NULL UNIQUE,
				runtime_instance_id text NOT NULL,
				runtime_sandbox_name text NOT NULL,
				owned boolean NOT NULL DEFAULT true,
				operation_id text,
				operation_started_at timestamp,
				provisioned_at timestamp,
				cleanup_attempted_at timestamp,
				cleanup_completed_at timestamp,
				last_error text,
				created_at timestamp NOT NULL DEFAULT now(),
				updated_at timestamp NOT NULL DEFAULT now(),
				PRIMARY KEY (workflow_execution_id, purpose)
			);
			INSERT INTO workflow_executions (id, status) VALUES
				('execution-1', 'running'),
				('execution-terminal', 'success'),
				('execution-stopping', 'running');
			UPDATE workflow_executions
			SET stop_requested_at = '2026-07-22T11:55:00Z'
			WHERE id = 'execution-stopping';
		`);
		repository = new PostgresWorkflowExecutionRuntimeHostRepository(
			drizzle(client) as never,
		);
	});

	afterEach(async () => {
		await client.close();
	});

	it("reserves before create, reuses the immutable generation, and fences terminal executions", async () => {
		await expect(
			repository.reserve({
				proposedTarget: target(),
				operationId: "operation-1",
				startedAt: STARTED_AT,
				staleBefore: new Date(STARTED_AT.getTime() - 1),
			}),
		).resolves.toEqual({ status: "reserved", target: target() });

		await expect(
			repository.publish({
				...target(),
				operationId: "operation-1",
				publishedAt: new Date("2026-07-22T12:01:00Z"),
			}),
		).resolves.toEqual({ status: "published" });

		const replacementProposal = target({
			generationStartedAt: new Date("2026-07-22T12:02:00Z"),
			runtimeAppId: "agent-session-generation-two",
			runtimeSandboxName: "agent-host-agent-session-generation-two",
		});
		await expect(
			repository.reserve({
				proposedTarget: replacementProposal,
				operationId: "operation-2",
				startedAt: new Date("2026-07-22T12:02:00Z"),
				staleBefore: new Date("2026-07-22T11:47:00Z"),
			}),
		).resolves.toEqual({ status: "busy" });
		await expect(
			repository.completeActivation({
				...target(),
				operationId: "operation-1",
				activatedAt: new Date("2026-07-22T12:01:30Z"),
			}),
		).resolves.toEqual({ status: "activated" });
		await expect(
			repository.reserve({
				proposedTarget: replacementProposal,
				operationId: "operation-2",
				startedAt: new Date("2026-07-22T12:02:00Z"),
				staleBefore: new Date("2026-07-22T11:47:00Z"),
			}),
		).resolves.toEqual({ status: "reserved", target: target() });

		await expect(
			repository.reserve({
				proposedTarget: target({ executionId: "execution-terminal" }),
				operationId: "terminal-op",
				startedAt: STARTED_AT,
				staleBefore: new Date(STARTED_AT.getTime() - 1),
			}),
		).resolves.toEqual({ status: "execution_not_active" });
		await expect(
			repository.reserve({
				proposedTarget: target({ executionId: "execution-stopping" }),
				operationId: "stopping-op",
				startedAt: STARTED_AT,
				staleBefore: new Date(STARTED_AT.getTime() - 1),
			}),
		).resolves.toEqual({ status: "execution_not_active" });
	});

	it("does not expose a fresh operation to cleanup", async () => {
		await repository.reserve({
			proposedTarget: target(),
			operationId: "operation-fresh",
			startedAt: STARTED_AT,
			staleBefore: new Date(STARTED_AT.getTime() - 1),
		});
		await client.exec(`
			UPDATE workflow_executions SET status = 'success' WHERE id = 'execution-1'
		`);

		await expect(
			repository.listPendingCleanup({
				limit: 10,
				availableBefore: STALE_BEFORE,
				operationStaleBefore: new Date(STARTED_AT.getTime() - 1),
			}),
		).resolves.toEqual([]);
	});

	it("does not clean an active execution merely because stop was requested", async () => {
		await repository.reserve({
			proposedTarget: target(),
			operationId: "operation-before-stop",
			startedAt: STARTED_AT,
			staleBefore: new Date(STARTED_AT.getTime() - 1),
		});
		await repository.publish({
			...target(),
			operationId: "operation-before-stop",
			publishedAt: new Date("2026-07-22T12:01:00Z"),
		});
		await client.exec(`
			UPDATE workflow_executions
			SET stop_requested_at = '2026-07-22T12:02:00Z'
			WHERE id = 'execution-1'
		`);

		await expect(
			repository.listPendingCleanup({
				limit: 10,
				availableBefore: STALE_BEFORE,
				operationStaleBefore: STALE_BEFORE,
			}),
		).resolves.toEqual([]);
		await expect(
			repository.claimCleanup({
				...target(),
				attemptedAt: STALE_BEFORE,
				availableBefore: new Date(STALE_BEFORE.getTime() - 1),
				operationStaleBefore: STALE_BEFORE,
			}),
		).resolves.toBe(false);
		await expect(
			repository.acknowledgeCleanup({
				...target(),
				completedAt: new Date("2026-07-22T12:16:00Z"),
			}),
		).resolves.toBe(false);
	});

	it("blocks parent deletion from erasing a provider cleanup obligation", async () => {
		await repository.reserve({
			proposedTarget: target(),
			operationId: "operation-parent-fence",
			startedAt: STARTED_AT,
			staleBefore: new Date(STARTED_AT.getTime() - 1),
		});

		await expect(
			client.exec(`DELETE FROM workflow_executions WHERE id = 'execution-1'`),
		).rejects.toThrow();
	});

	it("uses exact CAS and makes a late publisher lose after stale cleanup wins", async () => {
		await repository.reserve({
			proposedTarget: target(),
			operationId: "operation-stale",
			startedAt: STARTED_AT,
			staleBefore: new Date(STARTED_AT.getTime() - 1),
		});
		await client.exec(`
			UPDATE workflow_executions SET status = 'success' WHERE id = 'execution-1'
		`);
		const candidates = await repository.listPendingCleanup({
			limit: 10,
			availableBefore: STALE_BEFORE,
			operationStaleBefore: STALE_BEFORE,
		});
		expect(candidates).toEqual([target()]);

		const claims = await Promise.all([
			repository.claimCleanup({
				...target(),
				attemptedAt: STALE_BEFORE,
				availableBefore: new Date(STALE_BEFORE.getTime() - 1),
				operationStaleBefore: STALE_BEFORE,
			}),
			repository.claimCleanup({
				...target(),
				attemptedAt: STALE_BEFORE,
				availableBefore: new Date(STALE_BEFORE.getTime() - 1),
				operationStaleBefore: STALE_BEFORE,
			}),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		await expect(
			repository.acknowledgeCleanup({
				...target(),
				completedAt: new Date("2026-07-22T12:16:00Z"),
			}),
		).resolves.toBe(true);

		await expect(
			repository.publish({
				...target(),
				operationId: "operation-stale",
				publishedAt: new Date("2026-07-22T12:17:00Z"),
			}),
		).resolves.toEqual({ status: "execution_not_active" });
		await expect(
			repository.beginRollback({
				...target(),
				operationId: "operation-stale",
				startedAt: new Date("2026-07-22T12:17:01Z"),
				error: "late create returned after cleanup acknowledgement",
			}),
		).resolves.toEqual({ status: "cleanup_complete" });
		await expect(
			repository.acknowledgeCleanup({
				...target(),
				completedAt: new Date("2026-07-22T12:18:00Z"),
			}),
		).resolves.toBe(false);
	});

	it("retains rollback authority when the execution stops during activation", async () => {
		await repository.reserve({
			proposedTarget: target(),
			operationId: "operation-activation",
			startedAt: STARTED_AT,
			staleBefore: new Date(STARTED_AT.getTime() - 1),
		});
		await expect(
			repository.publish({
				...target(),
				operationId: "operation-activation",
				publishedAt: new Date("2026-07-22T12:01:00Z"),
			}),
		).resolves.toEqual({ status: "published" });
		await client.exec(`
			UPDATE workflow_executions SET status = 'cancelled' WHERE id = 'execution-1'
		`);

		await expect(
			repository.completeActivation({
				...target(),
				operationId: "operation-activation",
				activatedAt: new Date("2026-07-22T12:02:00Z"),
			}),
		).resolves.toEqual({ status: "execution_not_active" });
		await expect(
			repository.beginRollback({
				...target(),
				operationId: "operation-activation",
				startedAt: new Date("2026-07-22T12:02:01Z"),
				error: "execution stopped during activation",
			}),
		).resolves.toEqual({ status: "claimed" });
	});

	it("fences a stale rollback after a successor acquires the generation", async () => {
		await repository.reserve({
			proposedTarget: target(),
			operationId: "operation-stale",
			startedAt: STARTED_AT,
			staleBefore: new Date(STARTED_AT.getTime() - 1),
		});
		const successorStartedAt = new Date("2026-07-22T12:16:00Z");
		await expect(
			repository.reserve({
				proposedTarget: target(),
				operationId: "operation-successor",
				startedAt: successorStartedAt,
				staleBefore: new Date("2026-07-22T12:01:00Z"),
			}),
		).resolves.toEqual({ status: "reserved", target: target() });

		await expect(
			repository.beginRollback({
				...target(),
				operationId: "operation-stale",
				startedAt: new Date("2026-07-22T12:16:01Z"),
				error: "late stale request",
			}),
		).resolves.toEqual({ status: "lost" });
		await expect(
			repository.publish({
				...target(),
				operationId: "operation-successor",
				publishedAt: new Date("2026-07-22T12:16:02Z"),
			}),
		).resolves.toEqual({ status: "published" });
	});
});

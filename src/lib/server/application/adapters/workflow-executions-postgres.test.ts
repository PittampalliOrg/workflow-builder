import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresWorkflowExecutionRepository } from "$lib/server/application/adapters/postgres";

describe("PostgresWorkflowExecutionRepository status compare-and-set", () => {
	let client: PGlite;
	let repository: PostgresWorkflowExecutionRepository;

	beforeEach(async () => {
		client = new PGlite();
		await client.exec(`
			CREATE TABLE workflow_executions (
				id text PRIMARY KEY,
				workflow_id text NOT NULL,
				user_id text NOT NULL,
				project_id text,
				status text NOT NULL,
				input jsonb,
				output jsonb,
				execution_ir_version text,
				execution_ir jsonb,
				error text,
				dapr_instance_id text,
				phase text,
				progress integer,
				current_node_id text,
				current_node_name text,
				primary_trace_id text,
				workflow_session_id text,
				mlflow_experiment_id text,
				mlflow_run_id text,
				summary_output jsonb,
				error_stack_trace text,
				rerun_of_execution_id text,
				rerun_source_instance_id text,
				resume_from_node text,
				seed_workspace_from text,
				trigger_source text,
				rerun_from_event_id integer,
				started_at timestamp NOT NULL DEFAULT now(),
				completed_at timestamp,
				duration text,
				stop_requested_at timestamp,
				stop_requested_mode text,
				stop_reason text,
				archived_at timestamp
			);
			INSERT INTO workflow_executions (
				id, workflow_id, user_id, project_id, status, phase, progress,
				dapr_instance_id, stop_requested_at
			) VALUES
				('active-1', 'wf-1', 'user-1', 'project-1', 'running', 'running', 40, 'inst-1', NULL),
				('winner-1', 'wf-1', 'user-1', 'project-1', 'error', 'failed', 100, 'inst-2', NULL),
				('terminal-1', 'wf-1', 'user-1', 'project-1', 'success', 'completed', 100, 'inst-3', NULL),
				('stopping-1', 'wf-1', 'user-1', 'project-1', 'running', 'running', 40, 'inst-4', now());
		`);
    repository = new PostgresWorkflowExecutionRepository(
      drizzle(client) as never,
    );
	});

	afterEach(async () => {
		await client.close();
	});

	it("applies a runtime projection only to an active row without stop intent", async () => {
		await expect(
			repository.applyRuntimeProjection("active-1", {
				status: "success",
				phase: "completed",
				progress: 100,
			}),
		).resolves.toEqual({ applied: true });

		await expect(repository.getById("active-1")).resolves.toMatchObject({
			status: "success",
			phase: "completed",
			progress: 100,
		});
	});

	it("rejects terminal and nonterminal runtime projections after stop intent", async () => {
		await expect(
			repository.applyRuntimeProjection("stopping-1", {
				phase: "finalizing",
				progress: 90,
			}),
		).resolves.toMatchObject({
			applied: false,
			reason: "stop_requested",
			currentStatus: "running",
		});
		await expect(
			repository.applyRuntimeProjection("stopping-1", {
				status: "success",
				phase: "completed",
				progress: 100,
			}),
		).resolves.toMatchObject({
			applied: false,
			reason: "stop_requested",
		});

		await expect(repository.getById("stopping-1")).resolves.toMatchObject({
			status: "running",
			phase: "running",
			progress: 40,
		});
	});

	it("updates an exact active status and returns the persisted row", async () => {
		const record = await repository.compareAndSetReadModel({
			executionId: "active-1",
			expectedStatus: "running",
			patch: {
				status: "success",
				phase: "completed",
				progress: 100,
				output: { result: "ok" },
			},
		});

		expect(record).toMatchObject({
			id: "active-1",
			status: "success",
			phase: "completed",
			progress: 100,
			output: { result: "ok" },
		});
	});

	it("returns the current row without overwriting it when the expected status loses", async () => {
		const record = await repository.compareAndSetReadModel({
			executionId: "winner-1",
			expectedStatus: "running",
			patch: { status: "success", phase: "completed" },
		});

		expect(record).toMatchObject({
			id: "winner-1",
			status: "error",
			phase: "failed",
		});
	});

	it("does not reconcile runtime completion through a pending stop intent", async () => {
		const record = await repository.compareAndSetReadModel({
			executionId: "stopping-1",
			expectedStatus: "running",
			patch: { status: "success", phase: "completed", progress: 100 },
		});

		expect(record).toMatchObject({
			id: "stopping-1",
			status: "running",
			phase: "running",
			progress: 40,
		});
	});

	it("keeps an acknowledged lifecycle cancellation authoritative over runtime failure", async () => {
		await client.exec(`
			INSERT INTO workflow_executions (
				id, workflow_id, user_id, project_id, status, phase, progress,
				dapr_instance_id, stop_reason
			) VALUES (
				'cancelled-authoritative', 'wf-1', 'user-1', 'project-1',
				'cancelled', 'cancelled', 100, 'inst-cancelled', 'Stopped by user'
			)
		`);

		const record = await repository.compareAndSetReadModel({
			executionId: "cancelled-authoritative",
			expectedStatus: "cancelled",
			patch: { status: "error", phase: "failed", error: "runtime failed" },
		});

		expect(record).toMatchObject({
			status: "cancelled",
			phase: "cancelled",
			error: null,
			stopReason: "Stopped by user",
		});
	});

	it("fences late start failure after stop intent or terminal cancellation", async () => {
		await repository.markStartFailed({
			executionId: "stopping-1",
			error: "scheduler returned late",
		});
		await expect(repository.getById("stopping-1")).resolves.toMatchObject({
			status: "running",
			phase: "running",
			error: null,
		});

		await client.exec(`
			INSERT INTO workflow_executions (
				id, workflow_id, user_id, project_id, status, phase, progress,
				dapr_instance_id, stop_reason
			) VALUES (
				'cancelled-start', 'wf-1', 'user-1', 'project-1', 'cancelled',
				'cancelled', 100, 'placeholder', 'Stopped by user'
			)
		`);
		await repository.markStartFailed({
			executionId: "cancelled-start",
			error: "scheduler returned late",
		});
		await expect(repository.getById("cancelled-start")).resolves.toMatchObject({
			status: "cancelled",
			phase: "cancelled",
			error: null,
		});
	});

	it("attaches late scheduler linkage without reopening cancellation and rearms cleanup", async () => {
		await client.exec(`
			INSERT INTO workflow_executions (
				id, workflow_id, user_id, project_id, status, phase, progress,
				dapr_instance_id, stop_reason
			) VALUES (
				'cancelled-attach', 'wf-1', 'user-1', 'project-1', 'cancelled',
				'cancelled', 100, 'placeholder', 'Stopped by user'
			)
		`);

		await repository.attachSchedulerInstance({
			executionId: "cancelled-attach",
			instanceId: "late-real-instance",
			workflowSessionId: "late-session",
			primaryTraceId: "late-trace",
		});

		await expect(repository.getById("cancelled-attach")).resolves.toMatchObject({
			status: "cancelled",
			phase: "cancelled",
			progress: 100,
			daprInstanceId: "late-real-instance",
			workflowSessionId: "late-session",
			primaryTraceId: "late-trace",
			stopReason: "Stopped by user",
			stopRequestedAt: expect.any(Date),
		});
		const intent = await client.query<{ stop_requested_mode: string | null }>(`
			SELECT stop_requested_mode
			FROM workflow_executions
			WHERE id = 'cancelled-attach'
		`);
		expect(intent.rows[0]?.stop_requested_mode).toBe("terminate");

		await client.exec(`
			UPDATE workflow_executions
			SET stop_requested_at = NULL
			WHERE id = 'cancelled-attach'
		`);
		await repository.attachSchedulerInstance({
			executionId: "cancelled-attach",
			instanceId: "late-real-instance",
		});
		await expect(repository.getById("cancelled-attach")).resolves.toMatchObject({
			stopRequestedAt: null,
		});
	});

	it.each(["purge", "reset"] as const)(
		"retains acknowledged %s strength when new scheduler linkage appears",
		async (mode) => {
			const id = `cancelled-attach-${mode}`;
			await client.query(
				`INSERT INTO workflow_executions (
					id, workflow_id, user_id, project_id, status, phase, progress,
					dapr_instance_id, stop_requested_mode, stop_reason
				) VALUES (
					$1, 'wf-1', 'user-1', 'project-1', 'cancelled', 'cancelled',
					100, 'placeholder', $2, 'Stopped by user'
				)`,
				[id, mode],
			);

			await repository.attachSchedulerInstance({
				executionId: id,
				instanceId: `late-${mode}-instance`,
			});

			const result = await client.query<{
				dapr_instance_id: string | null;
				stop_requested_at: Date | null;
				stop_requested_mode: string | null;
			}>(`
				SELECT dapr_instance_id, stop_requested_at, stop_requested_mode
				FROM workflow_executions
				WHERE id = '${id}'
			`);
			expect(result.rows[0]).toMatchObject({
				dapr_instance_id: `late-${mode}-instance`,
				stop_requested_at: expect.any(Date),
				stop_requested_mode: mode,
			});
		},
	);

	it("supports a hard runtime correction from an expected terminal status", async () => {
		const record = await repository.compareAndSetReadModel({
			executionId: "terminal-1",
			expectedStatus: "success",
			patch: { status: "error", phase: "failed", error: "runtime failed" },
		});

		expect(record).toMatchObject({
			id: "terminal-1",
			status: "error",
			phase: "failed",
			error: "runtime failed",
		});
	});
});

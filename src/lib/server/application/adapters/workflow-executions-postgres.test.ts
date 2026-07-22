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
				trigger_source text,
				rerun_from_event_id integer,
				started_at timestamp NOT NULL DEFAULT now(),
				completed_at timestamp,
				duration text,
				stop_requested_at timestamp,
				stop_requested_mode text,
				stop_reason text
			);
			INSERT INTO workflow_executions (
				id, workflow_id, user_id, project_id, status, phase, progress,
				dapr_instance_id
			) VALUES
				('active-1', 'wf-1', 'user-1', 'project-1', 'running', 'running', 40, 'inst-1'),
				('winner-1', 'wf-1', 'user-1', 'project-1', 'error', 'failed', 100, 'inst-2'),
				('terminal-1', 'wf-1', 'user-1', 'project-1', 'success', 'completed', 100, 'inst-3');
		`);
    repository = new PostgresWorkflowExecutionRepository(
      drizzle(client) as never,
    );
	});

	afterEach(async () => {
		await client.close();
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

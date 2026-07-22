import { describe, expect, it } from "vitest";
import { DaprPostgresWorkflowExecutionRepository } from "$lib/server/application/adapters/workflow-executions-dapr-postgres";
import type {
	DaprPostgresBindingCall,
	DaprPostgresBindingResult,
} from "$lib/server/application/adapters/dapr-postgres-binding";

class FakeBindingClient {
	calls: DaprPostgresBindingCall[] = [];
	queryRows = new Map<string, unknown[][]>();
	execRowsAffected = 1;

	async query(
		input: Omit<DaprPostgresBindingCall, "operation">,
	): Promise<DaprPostgresBindingResult> {
		this.calls.push({ ...input, operation: "query" });
		return {
			metadata: {},
			rows: this.queryRows.get(input.summary ?? "") ?? [],
			rowsAffected: null,
		};
	}

	async exec(
		input: Omit<DaprPostgresBindingCall, "operation">,
	): Promise<DaprPostgresBindingResult> {
		this.calls.push({ ...input, operation: "exec" });
		return {
			metadata: { "rows-affected": String(this.execRowsAffected) },
			rows: [],
			rowsAffected: this.execRowsAffected,
		};
	}
}

function repo(client: FakeBindingClient) {
	return new DaprPostgresWorkflowExecutionRepository(
		{} as ConstructorParameters<typeof DaprPostgresWorkflowExecutionRepository>[0],
		client,
	);
}

function executionRow(overrides: {
	status?: string;
	phase?: string | null;
	progress?: number | null;
	output?: unknown;
	error?: string | null;
	completedAt?: string | null;
	stopRequestedAt?: string | null;
	stopReason?: string | null;
} = {}): unknown[] {
	return [
		"exec-1",
		"wf-1",
		"user-1",
		"project-1",
		overrides.status ?? "running",
		'{"topic":"x"}',
		JSON.stringify(overrides.output ?? { ok: true }),
		"sw1",
		'{"nodes":[]}',
		overrides.error ?? null,
		"inst-1",
		overrides.phase ?? "running",
		overrides.progress ?? 10,
		"node-1",
		"Node 1",
		"trace-1",
		"session-1",
		null,
		null,
		'{"summary":true}',
		null,
		null,
		null,
		null,
		"manual",
		null,
		"2026-07-09T12:00:00.000Z",
		overrides.completedAt ?? null,
		null,
		overrides.stopRequestedAt ?? null,
		overrides.stopReason ?? null,
	];
}

describe("DaprPostgresWorkflowExecutionRepository", () => {
	it("maps workflow execution rows from the binding", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_executions.select_by_id", [executionRow()]);

		const record = await repo(client).getById("exec-1");

		expect(record?.id).toBe("exec-1");
		expect(record?.input).toEqual({ topic: "x" });
		expect(record?.summaryOutput).toEqual({ summary: true });
		expect(record?.startedAt.toISOString()).toBe("2026-07-09T12:00:00.000Z");
		expect(client.calls[0]).toMatchObject({
			operation: "query",
			summary: "workflow_executions.select_by_id",
			collection: "workflow_executions",
			params: ["exec-1"],
			paramNames: ["id"],
		});
	});

	it("inserts workflow executions through the binding with JSON casts", async () => {
		const client = new FakeBindingClient();

		await repo(client).create({
			id: "exec-1",
			workflowId: "wf-1",
			userId: "user-1",
			projectId: "project-1",
			status: "pending",
			input: { topic: "x" },
			output: { ok: true },
			executionIr: { nodes: [] },
			executionIrVersion: "sw1",
		});

		expect(client.calls[0]).toMatchObject({
			operation: "exec",
			summary: "workflow_executions.insert",
			collection: "workflow_executions",
		});
		expect(client.calls[0]?.sql).toContain("CAST($8 AS jsonb)");
		expect(client.calls[0]?.params?.[7]).toBe('{"topic":"x"}');
		expect(client.calls[0]?.spanParams?.[7]).toEqual({ topic: "x" });
	});

	it("updates only supported read-model fields through the binding", async () => {
		const client = new FakeBindingClient();

		await repo(client).applyRuntimeProjection("exec-1", {
			status: "running",
			output: { ok: true },
			summaryOutput: { summary: true },
		});

		expect(client.calls[0]).toMatchObject({
			operation: "exec",
			summary: "workflow_executions.update_read_model",
			collection: "workflow_executions",
			paramNames: ["id", "status", "output", "summary_output"],
		});
		expect(client.calls[0]?.sql).toContain("output = CAST($3 AS jsonb)");
		expect(client.calls[0]?.sql).toContain("summary_output = CAST($4 AS jsonb)");
		expect(client.calls[0]?.sql).toContain("status IN ('pending', 'running')");
		expect(client.calls[0]?.sql).toContain("stop_requested_at IS NULL");
	});

	it("reports a stop-superseded runtime projection without changing the row", async () => {
		const client = new FakeBindingClient();
		client.execRowsAffected = 0;
		client.queryRows.set("workflow_executions.select_by_id", [
			executionRow({
				status: "running",
				phase: "running",
				stopRequestedAt: "2026-07-22T08:23:45.000Z",
			}),
		]);

		await expect(
			repo(client).applyRuntimeProjection("exec-1", {
				status: "success",
				phase: "completed",
			}),
		).resolves.toMatchObject({
			applied: false,
			reason: "stop_requested",
			currentStatus: "running",
		});
		expect(client.calls.map((call) => call.summary)).toEqual([
			"workflow_executions.update_read_model",
			"workflow_executions.select_by_id",
		]);
	});

	it("atomically reconciles an active status and returns the updated row", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_executions.select_by_id", [
			executionRow({
				status: "success",
				phase: "completed",
				progress: 100,
				output: { result: "ok" },
				completedAt: "2026-07-09T12:00:30.000Z",
			}),
		]);

		const record = await repo(client).compareAndSetReadModel({
			executionId: "exec-1",
			expectedStatus: "running",
			patch: {
				status: "success",
				phase: "completed",
				progress: 100,
				output: { result: "ok" },
			},
		});

		expect(record).toMatchObject({
			id: "exec-1",
			status: "success",
			phase: "completed",
			output: { result: "ok" },
		});
		expect(client.calls[0]).toMatchObject({
			operation: "exec",
			summary: "workflow_executions.compare_and_set_read_model",
			paramNames: ["id", "expected_status", "status", "phase", "progress", "output"],
			params: ["exec-1", "running", "success", "completed", 100, '{"result":"ok"}'],
		});
		expect(client.calls[0]?.sql).toContain("AND status = $2");
		expect(client.calls[0]?.sql).toContain("stop_requested_at IS NULL");
		expect(client.calls[0]?.sql).not.toContain("RETURNING");
		expect(client.calls.map((call) => call.summary)).toEqual([
			"workflow_executions.compare_and_set_read_model",
			"workflow_executions.select_by_id",
		]);
	});

	it("fences runtime status reconciliation while stop intent is pending", async () => {
		const client = new FakeBindingClient();
		client.execRowsAffected = 0;
		client.queryRows.set("workflow_executions.select_by_id", [
			executionRow({
				status: "running",
				phase: "running",
				stopRequestedAt: "2026-07-22T08:23:45.000Z",
			}),
		]);

		const record = await repo(client).compareAndSetReadModel({
			executionId: "exec-1",
			expectedStatus: "running",
			patch: { status: "success", phase: "completed" },
		});

		expect(record).toMatchObject({ status: "running", phase: "running" });
		expect(client.calls[0]?.sql).toContain("stop_requested_at IS NULL");
	});

	it("keeps acknowledged lifecycle cancellation outside runtime correction", async () => {
		const client = new FakeBindingClient();
		client.execRowsAffected = 0;
		client.queryRows.set("workflow_executions.select_by_id", [
			executionRow({
				status: "cancelled",
				phase: "cancelled",
				progress: 100,
				stopReason: "Stopped by user",
			}),
		]);

		const record = await repo(client).compareAndSetReadModel({
			executionId: "exec-1",
			expectedStatus: "cancelled",
			patch: { status: "error", phase: "failed", error: "runtime failed" },
		});

		expect(record).toMatchObject({
			status: "cancelled",
			phase: "cancelled",
			stopReason: "Stopped by user",
		});
		expect(client.calls[0]?.sql).toContain(
			"status <> 'cancelled' OR stop_reason IS NULL",
		);
	});

	it("always attaches scheduler linkage while preserving lifecycle-owned fields", async () => {
		const client = new FakeBindingClient();

		await repo(client).attachSchedulerInstance({
			executionId: "exec-1",
			instanceId: "late-instance",
			workflowSessionId: "late-session",
			primaryTraceId: "late-trace",
		});

		expect(client.calls[0]).toMatchObject({
			summary: "workflow_executions.attach_scheduler_instance",
			params: ["exec-1", "late-instance", "late-session", "late-trace"],
		});
		expect(client.calls[0]?.sql).toContain("dapr_instance_id = $2");
		expect(client.calls[0]?.sql).toContain("THEN 'running' ELSE phase END");
		expect(client.calls[0]?.sql).toContain(
			"dapr_instance_id IS DISTINCT FROM $2",
		);
		expect(client.calls[0]?.sql).toContain(
			"THEN coalesce(stop_requested_mode, 'terminate')",
		);
		const normalizedSql = client.calls[0]?.sql?.replace(/\s+/g, " ").trim();
		expect(normalizedSql).toMatch(/WHERE id = \$1$/);
	});

	it("fences a late scheduler start failure behind active lifecycle state", async () => {
		const client = new FakeBindingClient();

		await repo(client).markStartFailed({
			executionId: "exec-1",
			error: "scheduler returned late",
		});

		expect(client.calls[0]?.sql).toContain("status IN ('pending', 'running')");
		expect(client.calls[0]?.sql).toContain("stop_requested_at IS NULL");
	});

	it("allows an expected terminal status to be corrected", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_executions.select_by_id", [
			executionRow({ status: "error", phase: "failed", error: "runtime failed" }),
		]);

		const record = await repo(client).compareAndSetReadModel({
			executionId: "exec-1",
			expectedStatus: "success",
			patch: { status: "error", phase: "failed", error: "runtime failed" },
		});

		expect(record?.status).toBe("error");
		expect(client.calls[0]?.params?.slice(0, 2)).toEqual(["exec-1", "success"]);
	});

	it("returns the current winner row when the status comparison loses", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_executions.select_by_id", [
			executionRow({
				status: "error",
				phase: "failed",
				progress: 100,
				output: { success: false },
				error: "agent budget exhausted",
			}),
		]);

		const record = await repo(client).compareAndSetReadModel({
			executionId: "exec-1",
			expectedStatus: "running",
			patch: { status: "success" },
		});

		expect(record).toMatchObject({
			status: "error",
			phase: "failed",
			output: { success: false },
			error: "agent budget exhausted",
		});
		expect(client.calls.map((call) => call.summary)).toEqual([
			"workflow_executions.compare_and_set_read_model",
			"workflow_executions.select_by_id",
		]);
	});

	it("appends and reloads execution logs through the binding", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_execution_logs.select_by_pk", [
			[
				"log-1",
				"exec-1",
				"node-1",
				"Node 1",
				"durable/run",
				null,
				"success",
				'{"prompt":"hi"}',
				'{"ok":true}',
				null,
				"2026-07-09T12:00:00.000Z",
				"2026-07-09T12:00:01.000Z",
				"1000",
				"2026-07-09T12:00:00.000Z",
				null,
				null,
				null,
				1000,
				"fn",
				"false",
			],
		]);

		const record = await repo(client).appendLog({
			id: "log-1",
			executionId: "exec-1",
			nodeId: "node-1",
			nodeName: "Node 1",
			nodeType: "durable/run",
			status: "success",
			input: { prompt: "hi" },
			output: { ok: true },
			executionMs: 1000,
			routedTo: "fn",
			wasColdStart: false,
		});

		expect(record.output).toEqual({ ok: true });
		expect(client.calls.map((call) => call.summary)).toEqual([
			"workflow_execution_logs.insert",
			"workflow_execution_logs.select_by_pk",
		]);
		expect(client.calls[0]?.collection).toBe("workflow_execution_logs");
	});
});

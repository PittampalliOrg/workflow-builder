import { describe, expect, it } from "vitest";
import { DaprPostgresWorkflowExecutionRepository } from "$lib/server/application/adapters/workflow-executions-dapr-postgres";
import type {
	DaprPostgresBindingCall,
	DaprPostgresBindingResult,
} from "$lib/server/application/adapters/dapr-postgres-binding";

class FakeBindingClient {
	calls: DaprPostgresBindingCall[] = [];
	queryRows = new Map<string, unknown[][]>();

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
		return { metadata: { "rows-affected": "1" }, rows: [], rowsAffected: 1 };
	}
}

function repo(client: FakeBindingClient) {
	return new DaprPostgresWorkflowExecutionRepository(
		{} as ConstructorParameters<typeof DaprPostgresWorkflowExecutionRepository>[0],
		client,
	);
}

describe("DaprPostgresWorkflowExecutionRepository", () => {
	it("maps workflow execution rows from the binding", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_executions.select_by_id", [
			[
				"exec-1",
				"wf-1",
				"user-1",
				"project-1",
				"running",
				'{"topic":"x"}',
				'{"ok":true}',
				"sw1",
				'{"nodes":[]}',
				null,
				"inst-1",
				"running",
				10,
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
				null,
				null,
				null,
				null,
			],
		]);

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

		await repo(client).updateReadModel("exec-1", {
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

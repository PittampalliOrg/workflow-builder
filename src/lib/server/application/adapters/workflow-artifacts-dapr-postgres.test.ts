import { describe, expect, it } from "vitest";
import type {
	DaprPostgresBindingCall,
	DaprPostgresBindingResult,
} from "$lib/server/application/adapters/dapr-postgres-binding";
import {
	DaprPostgresArtifactStore,
	DaprPostgresWorkflowPlanArtifactStore,
} from "$lib/server/application/adapters/workflow-artifacts-dapr-postgres";

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

function artifactStore(client: FakeBindingClient) {
	return new DaprPostgresArtifactStore(client);
}

function planArtifactStore(client: FakeBindingClient) {
	return new DaprPostgresWorkflowPlanArtifactStore(client);
}

describe("DaprPostgresArtifactStore", () => {
	it("upserts artifact metadata through the binding with JSON casts", async () => {
		const client = new FakeBindingClient();

		await artifactStore(client).upsertWorkflowArtifact({
			id: "artifact-1",
			workflowExecutionId: "exec-1",
			nodeId: "node-1",
			slot: "primary",
			kind: "source-bundle",
			title: "Source bundle",
			description: null,
			inlinePayload: { path: "bundle.zip" },
			fileId: "file-1",
			contentType: "application/zip",
			sizeBytes: 42,
			metadata: { commit: "abc123" },
		});

		expect(client.calls[0]).toMatchObject({
			operation: "exec",
			summary: "workflow_artifacts.upsert",
			collection: "workflow_artifacts",
			paramNames: [
				"id",
				"workflow_execution_id",
				"node_id",
				"slot",
				"kind",
				"title",
				"description",
				"inline_payload",
				"file_id",
				"content_type",
				"size_bytes",
				"metadata",
			],
		});
		expect(client.calls[0]?.sql).toContain("CAST($8 AS jsonb)");
		expect(client.calls[0]?.sql).toContain("CAST($12 AS jsonb)");
		expect(client.calls[0]?.params?.[7]).toBe('{"path":"bundle.zip"}');
		expect(client.calls[0]?.spanParams?.[7]).toEqual({ path: "bundle.zip" });
		expect(client.calls[0]?.spanParams?.[11]).toEqual({ commit: "abc123" });
	});

	it("maps artifact rows from binding rows", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_artifacts.select_by_execution", [
			[
				"artifact-1",
				"exec-1",
				"node-1",
				"primary",
				"source-bundle",
				"Source bundle",
				null,
				'{"path":"bundle.zip"}',
				"file-1",
				"application/zip",
				"42",
				'{"commit":"abc123"}',
				"2026-07-09T12:00:00.000Z",
			],
		]);

		const records =
			await artifactStore(client).listWorkflowArtifactsByExecutionId("exec-1");

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			id: "artifact-1",
			workflowExecutionId: "exec-1",
			inlinePayload: { path: "bundle.zip" },
			metadata: { commit: "abc123" },
			sizeBytes: 42,
		});
		expect(records[0]?.createdAt.toISOString()).toBe(
			"2026-07-09T12:00:00.000Z",
		);
		expect(client.calls[0]).toMatchObject({
			operation: "query",
			summary: "workflow_artifacts.select_by_execution",
			collection: "workflow_artifacts",
			params: ["exec-1"],
			paramNames: ["workflow_execution_id"],
		});
	});

	it("qualifies source bundle list columns for joined queries", async () => {
		const client = new FakeBindingClient();

		await artifactStore(client).listSourceBundleArtifactsByWorkflowId("wf-1");

		expect(client.calls[0]).toMatchObject({
			operation: "query",
			summary: "workflow_artifacts.select_source_bundles_by_workflow",
			collection: "workflow_artifacts",
		});
		expect(client.calls[0]?.sql).toContain("wa.id");
		expect(client.calls[0]?.sql).toContain("INNER JOIN workflow_executions we");
		expect(client.calls[0]?.sql).not.toContain("wa.\n");
	});

	it("atomically updates metadata only while the reserved key is absent", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_artifacts.select_by_execution_and_id", [
			[
				"artifact-1",
				"exec-1",
				"dev-preview",
				"aux",
				"source-bundle",
				"Source bundle",
				null,
				"{}",
				"file-1",
				"application/gzip",
				"42",
				'{"previewAcceptanceAttestationV1":"signed"}',
				"2026-07-09T12:00:00.000Z",
			],
		]);

		await artifactStore(client).updateWorkflowArtifactMetadata({
			executionId: "exec-1",
			artifactId: "artifact-1",
			metadata: { previewAcceptanceAttestationV1: "signed" },
			ifAbsentMetadataKey: "previewAcceptanceAttestationV1",
		});

		expect(client.calls[0]).toMatchObject({
			summary: "workflow_artifacts.update_metadata_if_absent",
			params: [
				"exec-1",
				"artifact-1",
				'{"previewAcceptanceAttestationV1":"signed"}',
				"previewAcceptanceAttestationV1",
			],
		});
		expect(client.calls[0]?.sql).toContain(
			"NOT (COALESCE(metadata, '{}'::jsonb) ? $4)",
		);
		expect(client.calls).toHaveLength(2);
	});

	it("does not reload or report success when the conditional update loses", async () => {
		const client = new FakeBindingClient();
		client.execRowsAffected = 0;

		await expect(
			artifactStore(client).updateWorkflowArtifactMetadata({
				executionId: "exec-1",
				artifactId: "artifact-1",
				metadata: { previewAcceptanceAttestationV1: "replacement" },
				ifAbsentMetadataKey: "previewAcceptanceAttestationV1",
			}),
		).resolves.toBeNull();
		expect(client.calls).toHaveLength(1);
	});

	it("atomically merges metadata without replacing unrelated top-level keys", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_artifacts.select_by_execution_and_id", [
			[
				"artifact-1",
				"exec-1",
				"dev-preview",
				"aux",
				"source-bundle",
				"Source bundle",
				null,
				"{}",
				"file-1",
				"application/gzip",
				"42",
				'{"existing":"kept","promotion":{"receiptId":"receipt-1"}}',
				"2026-07-14T12:00:00.000Z",
			],
		]);

		await artifactStore(client).mergeWorkflowArtifactMetadata({
			executionId: "exec-1",
			artifactId: "artifact-1",
			patch: { promotion: { receiptId: "receipt-1" } },
			ifAbsentMetadataKey: "promotion",
		});

		expect(client.calls[0]).toMatchObject({
			summary: "workflow_artifacts.merge_metadata_if_absent",
			params: [
				"exec-1",
				"artifact-1",
				'{"promotion":{"receiptId":"receipt-1"}}',
				"promotion",
			],
		});
		expect(client.calls[0]?.sql).toContain(
			"COALESCE(metadata, '{}'::jsonb) || CAST($3 AS jsonb)",
		);
		expect(client.calls[0]?.sql).toContain(
			"NOT (COALESCE(metadata, '{}'::jsonb) ? $4)",
		);
		expect(client.calls).toHaveLength(2);
	});
});

describe("DaprPostgresWorkflowPlanArtifactStore", () => {
	it("upserts and reloads plan artifact metadata through the binding", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_plan_artifacts.select_by_id", [
			[
				"plan-1",
				"exec-1",
				"wf-1",
				"user-1",
				"node-1",
				"workspace-1",
				"/workspace",
				"claude_task_graph_v1",
				"1",
				"approved",
				"Ship it",
				'{"steps":[]}',
				"# Plan",
				"prompt",
				'{"source":"test"}',
				"2026-07-09T12:00:00.000Z",
				"2026-07-09T12:01:00.000Z",
			],
		]);

		const result = await planArtifactStore(client).upsertPlanArtifact({
			artifactRef: "plan-1",
			workflowExecutionId: "exec-1",
			workflowId: "wf-1",
			nodeId: "node-1",
			goal: "Ship it",
			planJson: { steps: [] },
			planMarkdown: "# Plan",
			sourcePrompt: "prompt",
			status: "approved",
			workspaceRef: "workspace-1",
			clonePath: "/workspace",
			metadata: { source: "test" },
		});

		expect(result).toEqual({
			artifactRef: "plan-1",
			storageBackend: "workflow_plan_artifacts",
			artifactType: "claude_task_graph_v1",
			status: "approved",
		});
		expect(client.calls.map((call) => call.summary)).toEqual([
			"workflow_plan_artifacts.upsert",
			"workflow_plan_artifacts.select_by_id",
		]);
		expect(client.calls[0]?.collection).toBe("workflow_plan_artifacts");
		expect(client.calls[0]?.sql).toContain("CAST($10 AS jsonb)");
		expect(client.calls[0]?.sql).toContain("CAST($13 AS jsonb)");
		expect(client.calls[0]?.params?.[9]).toBe('{"steps":[]}');
		expect(client.calls[0]?.spanParams?.[9]).toEqual({ steps: [] });
	});

	it("maps plan artifact rows and optional metadata updates", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_plan_artifacts.select_by_execution", [
			[
				"plan-1",
				"exec-1",
				"wf-1",
				null,
				"node-1",
				null,
				null,
				"claude_task_graph_v1",
				"1",
				"draft",
				"Draft",
				'{"steps":[]}',
				null,
				null,
				null,
				"2026-07-09T12:00:00.000Z",
				"2026-07-09T12:01:00.000Z",
			],
		]);

		const records =
			await planArtifactStore(client).listPlanArtifactsByExecutionId("exec-1");
		await planArtifactStore(client).updatePlanArtifactStatus({
			artifactRef: "plan-1",
			status: "executed",
			metadata: { executed: true },
		});

		expect(records[0]).toMatchObject({
			artifactRef: "plan-1",
			userId: null,
			planJson: { steps: [] },
			metadata: null,
		});
		expect(client.calls[1]).toMatchObject({
			operation: "exec",
			summary: "workflow_plan_artifacts.update_status",
			collection: "workflow_plan_artifacts",
			params: ["plan-1", "executed", true, '{"executed":true}'],
			spanParams: ["plan-1", "executed", true, { executed: true }],
		});
	});
});

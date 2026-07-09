import { describe, expect, it } from "vitest";
import type {
	DaprPostgresBindingCall,
	DaprPostgresBindingResult,
} from "$lib/server/application/adapters/dapr-postgres-binding";
import { DaprPostgresWorkflowBrowserArtifactStore } from "$lib/server/application/adapters/workflow-browser-artifacts-dapr-postgres";
import type { WorkflowBrowserBlobPayload } from "$lib/server/application/ports/workflows";

class FakeBindingClient {
	calls: DaprPostgresBindingCall[] = [];
	queryRows = new Map<string, unknown[][]>();
	insertParams: unknown[] | null = null;

	async exec(
		input: Omit<DaprPostgresBindingCall, "operation">,
	): Promise<DaprPostgresBindingResult> {
		this.calls.push({ ...input, operation: "exec" });
		if (input.summary === "workflow_browser_artifacts.insert") {
			this.insertParams = input.params ?? [];
		}
		return {
			metadata: {},
			rows: [],
			rowsAffected: null,
		};
	}

	async query(
		input: Omit<DaprPostgresBindingCall, "operation">,
	): Promise<DaprPostgresBindingResult> {
		this.calls.push({ ...input, operation: "query" });
		if (input.summary === "workflow_browser_artifacts.select_by_id") {
			const insertParams = this.insertParams ?? [];
			const manifest = JSON.parse(String(insertParams[8] ?? "{}"));
			return {
				metadata: {},
				rowsAffected: null,
				rows: [
					[
						insertParams[0],
						insertParams[1],
						insertParams[2],
						insertParams[3],
						insertParams[4],
						insertParams[5],
						insertParams[6],
						insertParams[7],
						JSON.stringify(manifest),
						"2026-07-09T12:00:00.000Z",
						"2026-07-09T12:00:01.000Z",
					],
				],
			};
		}
		return {
			metadata: {},
			rows: this.queryRows.get(input.summary ?? "") ?? [],
			rowsAffected: null,
		};
	}
}

class FakeBlobPayloads {
	upserts: Array<{
		storageRef: string;
		payloadBase64: string;
		contentType: string;
	}> = [];
	payloads = new Map<string, WorkflowBrowserBlobPayload>();

	async upsertBlobPayload(input: {
		storageRef: string;
		payloadBase64: string;
		contentType: string;
	}): Promise<void> {
		this.upserts.push(input);
	}

	async getBlobPayload(
		storageRef: string,
	): Promise<WorkflowBrowserBlobPayload | null> {
		return this.payloads.get(storageRef) ?? null;
	}
}

function store(client: FakeBindingClient, blobs = new FakeBlobPayloads()) {
	return {
		blobs,
		store: new DaprPostgresWorkflowBrowserArtifactStore(blobs, client),
	};
}

describe("DaprPostgresWorkflowBrowserArtifactStore", () => {
	it("saves browser artifact metadata through the binding and delegates blob payloads", async () => {
		const client = new FakeBindingClient();
		const { store: browserArtifacts, blobs } = store(client);

		const record = await browserArtifacts.save({
			workflowExecutionId: "exec-1",
			workflowId: "wf-1",
			nodeId: "browser_validate",
			workspaceRef: "workspace-1",
			baseUrl: "https://example.test",
			status: "completed",
			metadata: { source: "test" },
			steps: [
				{
					id: "step-1",
					label: "Open page",
					url: "https://example.test",
					status: "completed",
				},
			],
			screenshots: [
				{
					label: "Screenshot",
					stepId: "step-1",
					payloadBase64: "cGl4ZWxz",
					contentType: "image/png",
				},
			],
			assets: [
				{
					kind: "video",
					label: "Recording",
					payloadBase64: "dmlkZW8=",
					contentType: "video/webm",
					fileName: "run.webm",
				},
			],
		});

		expect(record).toMatchObject({
			workflowExecutionId: "exec-1",
			workflowId: "wf-1",
			nodeId: "browser_validate",
			workspaceRef: "workspace-1",
			status: "completed",
			artifactType: "capture_flow_v1",
			artifactVersion: 1,
			manifestJson: {
				baseUrl: "https://example.test",
				status: "completed",
				metadata: { source: "test" },
			},
		});
		expect(record.id).toMatch(/^bwf_/);
		expect(blobs.upserts).toHaveLength(2);
		expect(blobs.upserts[0]).toMatchObject({
			payloadBase64: "cGl4ZWxz",
			contentType: "image/png",
		});
		expect(blobs.upserts[0]?.storageRef).toContain(
			`workflow-browser-artifacts/exec-1/${record.id}/screenshot-1.png`,
		);
		expect(blobs.upserts[1]?.storageRef).toContain(
			`workflow-browser-artifacts/exec-1/${record.id}/video-2.webm`,
		);

		expect(client.calls[0]).toMatchObject({
			operation: "exec",
			summary: "workflow_browser_artifacts.insert",
			collection: "workflow_browser_artifacts",
			paramNames: [
				"id",
				"workflow_execution_id",
				"workflow_id",
				"node_id",
				"workspace_ref",
				"artifact_type",
				"artifact_version",
				"status",
				"manifest_json",
			],
		});
		expect(client.calls[0]?.sql).toContain("CAST($9 AS jsonb)");
		expect(client.calls[0]?.sql).not.toContain("RETURNING");
		expect(client.calls[0]?.spanParams?.[8]).toMatchObject({
			baseUrl: "https://example.test",
			status: "completed",
		});
		expect(client.calls[1]).toMatchObject({
			operation: "query",
			summary: "workflow_browser_artifacts.select_by_id",
			collection: "workflow_browser_artifacts",
			params: [record.id],
			paramNames: ["id"],
		});
	});

	it("lists browser artifact metadata through the binding", async () => {
		const client = new FakeBindingClient();
		client.queryRows.set("workflow_browser_artifacts.select_by_execution", [
			[
				"bwf_1",
				"exec-1",
				"wf-1",
				"node-1",
				null,
				"capture_flow_v1",
				"1",
				"partial",
				'{"steps":[]}',
				"2026-07-09T12:00:00.000Z",
				"2026-07-09T12:01:00.000Z",
			],
		]);
		const { store: browserArtifacts } = store(client);

		const records = await browserArtifacts.listByExecutionId("exec-1");

		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			id: "bwf_1",
			workflowExecutionId: "exec-1",
			workflowId: "wf-1",
			status: "partial",
			manifestJson: { steps: [] },
		});
		expect(records[0]?.createdAt.toISOString()).toBe(
			"2026-07-09T12:00:00.000Z",
		);
		expect(records[0]?.updatedAt.toISOString()).toBe(
			"2026-07-09T12:01:00.000Z",
		);
		expect(client.calls[0]).toMatchObject({
			operation: "query",
			summary: "workflow_browser_artifacts.select_by_execution",
			collection: "workflow_browser_artifacts",
			params: ["exec-1"],
			paramNames: ["workflow_execution_id"],
		});
	});

	it("reads blob payloads from the delegated blob store", async () => {
		const client = new FakeBindingClient();
		const blobs = new FakeBlobPayloads();
		blobs.payloads.set("ref-1", {
			payloadBase64: "cGl4ZWxz",
			contentType: "image/png",
		});
		const { store: browserArtifacts } = store(client, blobs);

		await expect(browserArtifacts.getBlobPayload("ref-1")).resolves.toEqual({
			payloadBase64: "cGl4ZWxz",
			contentType: "image/png",
		});
		expect(client.calls).toHaveLength(0);
	});
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockSet = vi.hoisted(() => vi.fn());
const mockWhere = vi.hoisted(() => vi.fn());
const mockReturning = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth-helpers", () => ({
	getSession: mockGetSession,
}));

vi.mock("@/lib/db", () => ({
	db: {
		query: {
			workflows: {
				findFirst: mockFindFirst,
			},
		},
		update: mockUpdate,
	},
}));

vi.mock("@/lib/db/schema", () => ({
	workflows: {
		id: "id",
		userId: "user_id",
	},
}));

import { POST } from "./route";

describe("POST /api/workflows/[workflowId]/publish", () => {
	beforeEach(() => {
		mockGetSession.mockReset();
		mockFindFirst.mockReset();
		mockUpdate.mockReset();
		mockSet.mockReset();
		mockWhere.mockReset();
		mockReturning.mockReset();

		mockGetSession.mockResolvedValue({
			user: {
				id: "user-1",
			},
		});

		mockUpdate.mockReturnValue({
			set: mockSet,
		});
		mockSet.mockReturnValue({
			where: mockWhere,
		});
		mockWhere.mockReturnValue({
			returning: mockReturning,
		});
	});

	it("publishes a workflow with a frozen revision snapshot", async () => {
		mockFindFirst.mockResolvedValueOnce({
			id: "wf-1",
			name: "Visible Workflow",
			description: "Test workflow",
			userId: "user-1",
			nodes: [
				{
					id: "trigger",
					type: "trigger",
					position: { x: 0, y: 0 },
					data: {
						type: "trigger",
						label: "Manual Trigger",
						config: {},
					},
				},
				{
					id: "step-1",
					type: "action",
					position: { x: 240, y: 0 },
					data: {
						type: "action",
						label: "Run Action",
						config: { actionType: "test/action" },
					},
				},
			],
			edges: [
				{
					id: "edge-1",
					source: "trigger",
					target: "step-1",
				},
			],
			specVersion: "workflow-spec/v1",
			spec: {
				apiVersion: "workflow-spec/v1",
				name: "Visible Workflow",
				description: "Test workflow",
				metadata: {
					author: "vinod",
				},
				trigger: {
					id: "trigger",
					type: "manual",
					config: {},
					next: "step-1",
				},
				steps: [
					{
						id: "step-1",
						kind: "action",
						label: "Run Action",
						config: {
							actionType: "test/action",
						},
					},
				],
			},
			daprWorkflowName: null,
			createdAt: new Date("2026-03-29T12:00:00Z"),
			updatedAt: new Date("2026-03-29T12:00:00Z"),
		});
		mockReturning.mockImplementationOnce(async () => [
			{
				id: "wf-1",
				name: "Visible Workflow",
				description: "Test workflow",
				daprWorkflowName: "wf_wf-1",
				specVersion: "workflow-spec/v1",
				spec: {
					apiVersion: "workflow-spec/v1",
					name: "Visible Workflow",
					description: "Test workflow",
					metadata: {
						author: "vinod",
						publishedRuntime: {
							status: "published",
							workflowName: "wf_wf-1",
						},
					},
				},
				createdAt: new Date("2026-03-29T12:00:00Z"),
				updatedAt: new Date("2026-03-29T12:05:00Z"),
			},
		]);

		const response = await POST(
			new Request("http://localhost/api/workflows/wf-1/publish", {
				method: "POST",
			}),
			{ params: Promise.resolve({ workflowId: "wf-1" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(200);
		expect(mockSet).toHaveBeenCalledTimes(1);
		const updatePayload = mockSet.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(updatePayload.daprWorkflowName).toBe("wf_wf-1");
		expect(updatePayload.specVersion).toBe("workflow-spec/v1");
		expect(json.publishedRuntime).toMatchObject({
			status: "published",
			workflowName: "wf_wf-1",
		});
		expect(
			(
				(json.publishedRuntime as Record<string, unknown>).revisions as Array<
					Record<string, unknown>
				>
			)[0]?.definition,
		).toMatchObject({
			id: "wf-1",
			name: "Visible Workflow",
		});
	});
});

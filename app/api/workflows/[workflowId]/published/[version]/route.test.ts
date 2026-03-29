import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.hoisted(() => vi.fn());
const mockFindFirst = vi.hoisted(() => vi.fn());

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
	},
}));

vi.mock("@/lib/db/schema", () => ({
	workflows: {
		id: "id",
		userId: "user_id",
	},
}));

import { GET } from "./route";

describe("GET /api/workflows/[workflowId]/published/[version]", () => {
	beforeEach(() => {
		mockGetSession.mockReset();
		mockFindFirst.mockReset();

		mockGetSession.mockResolvedValue({
			user: {
				id: "user-1",
			},
		});
	});

	it("returns the latest published revision snapshot", async () => {
		mockFindFirst.mockResolvedValueOnce({
			id: "wf-1",
			name: "Visible Workflow",
			userId: "user-1",
			daprWorkflowName: "wf_wf-1",
			spec: {
				apiVersion: "workflow-spec/v1",
				name: "Visible Workflow",
				trigger: {
					id: "trigger",
					type: "manual",
					config: {},
					next: "step-1",
				},
				steps: [],
				metadata: {
					publishedRuntime: {
						status: "published",
						workflowName: "wf_wf-1",
						latestVersion: "pub_2",
						publishedAt: "2026-03-29T17:15:00Z",
						revisions: [
							{
								version: "pub_1",
								publishedAt: "2026-03-29T17:14:00Z",
								specVersion: "workflow-spec/v1",
								definition: { id: "wf-1", name: "Version 1" },
							},
							{
								version: "pub_2",
								publishedAt: "2026-03-29T17:15:00Z",
								specVersion: "workflow-spec/v1",
								definition: { id: "wf-1", name: "Version 2" },
							},
						],
					},
				},
			},
		});

		const response = await GET(
			new Request("http://localhost/api/workflows/wf-1/published/latest"),
			{ params: Promise.resolve({ workflowId: "wf-1", version: "latest" }) },
		);
		const json = await response.json();

		expect(response.status).toBe(200);
		expect(json.daprWorkflowName).toBe("wf_wf-1");
		expect(json.latestVersion).toBe("pub_2");
		expect(json.revision).toMatchObject({
			version: "pub_2",
			definition: {
				id: "wf-1",
				name: "Version 2",
			},
		});
		expect(json.revisions).toEqual([
			{
				version: "pub_1",
				publishedAt: "2026-03-29T17:14:00Z",
				specVersion: "workflow-spec/v1",
			},
			{
				version: "pub_2",
				publishedAt: "2026-03-29T17:15:00Z",
				specVersion: "workflow-spec/v1",
			},
		]);
	});

	it("returns 404 when the requested published version is missing", async () => {
		mockFindFirst.mockResolvedValueOnce({
			id: "wf-1",
			name: "Visible Workflow",
			userId: "user-1",
			daprWorkflowName: "wf_wf-1",
			spec: {
				apiVersion: "workflow-spec/v1",
				name: "Visible Workflow",
				trigger: {
					id: "trigger",
					type: "manual",
					config: {},
				},
				steps: [],
				metadata: {
					publishedRuntime: {
						status: "published",
						workflowName: "wf_wf-1",
						latestVersion: "pub_2",
						publishedAt: "2026-03-29T17:15:00Z",
						revisions: [
							{
								version: "pub_2",
								publishedAt: "2026-03-29T17:15:00Z",
								specVersion: "workflow-spec/v1",
								definition: { id: "wf-1", name: "Version 2" },
							},
						],
					},
				},
			},
		});

		const response = await GET(
			new Request("http://localhost/api/workflows/wf-1/published/pub_missing"),
			{
				params: Promise.resolve({
					workflowId: "wf-1",
					version: "pub_missing",
				}),
			},
		);
		const json = await response.json();

		expect(response.status).toBe(404);
		expect(json).toEqual({
			error: "Published workflow revision not found",
		});
	});
});

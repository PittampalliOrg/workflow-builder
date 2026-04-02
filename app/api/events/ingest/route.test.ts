import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.hoisted(() => vi.fn());
const mockExecutionFindMany = vi.hoisted(() => vi.fn());
const mockStartSupportedWorkflowExecution = vi.hoisted(() => vi.fn());
const mockIsValidInternalToken = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
	db: {
		query: {
			workflowExecutions: {
				findMany: mockExecutionFindMany,
			},
			workflows: {
				findFirst: mockFindFirst,
			},
		},
	},
}));

vi.mock("@/lib/db/schema", () => ({
	workflowExecutions: {
		workflowId: "workflow_id",
		startedAt: "started_at",
	},
	workflows: {
		id: "id",
	},
}));

vi.mock("@/lib/internal-api", () => ({
	isValidInternalToken: mockIsValidInternalToken,
}));

vi.mock("@/lib/workflows/start-supported-workflow-execution", () => ({
	StartSupportedWorkflowExecutionError: class StartSupportedWorkflowExecutionError extends Error {
		status: number;
		issues?: string[];

		constructor(message: string, status: number, issues?: string[]) {
			super(message);
			this.status = status;
			this.issues = issues;
		}
	},
	startSupportedWorkflowExecution: mockStartSupportedWorkflowExecution,
}));

import { POST } from "./route";

describe("POST /api/events/ingest", () => {
	beforeEach(() => {
		mockFindFirst.mockReset();
		mockExecutionFindMany.mockReset();
		mockStartSupportedWorkflowExecution.mockReset();
		mockIsValidInternalToken.mockReset();

		mockIsValidInternalToken.mockReturnValue(true);
		mockFindFirst.mockResolvedValue({
			id: "vajlzrprpie7fvco6ibhi",
			userId: "user-1",
			name: "Resolve Issue",
			description: null,
			nodes: [],
			edges: [],
			spec: { document: { dsl: "1.0.0" }, do: [] },
			specVersion: "sw-1.0.0",
		});
		mockExecutionFindMany.mockResolvedValue([]);
		mockStartSupportedWorkflowExecution.mockResolvedValue({
			executionId: "exec-1",
			instanceId: "inst-1",
			daprInstanceId: "inst-1",
			status: "running",
		});
	});

	it("rejects requests without the internal token", async () => {
		mockIsValidInternalToken.mockReturnValue(false);

		const response = await POST(
			new Request(
				"http://localhost/api/events/ingest?source=github&eventType=issues",
				{
					method: "POST",
					body: JSON.stringify({ payload: {} }),
				},
			),
		);

		expect(response.status).toBe(401);
	});

	it("ignores unmatched events", async () => {
		const response = await POST(
			new Request(
				"http://localhost/api/events/ingest?source=github&eventType=issues",
				{
					method: "POST",
					body: JSON.stringify({
						payload: {
							action: "opened",
							issue: { number: 1, title: "Issue", labels: [{ name: "bug" }] },
							repository: {
								name: "open-swe",
								owner: { login: "PittampalliOrg" },
							},
						},
					}),
				},
			),
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			status: "ignored",
		});
		expect(mockStartSupportedWorkflowExecution).not.toHaveBeenCalled();
	});

	it("starts the supported workflow for normalized GitHub events", async () => {
		const request = new Request(
			"http://localhost/api/events/ingest?source=github&eventType=issues",
			{
				method: "POST",
				body: JSON.stringify({
					eventId: "evt-1",
					receivedAt: "2026-04-02T12:00:00Z",
					payload: {
						action: "labeled",
						issue: {
							number: 11,
							title: "Fix issue",
							body: "Please fix",
							labels: [{ name: "dapr-swe" }],
						},
						repository: {
							name: "open-swe",
							owner: { login: "PittampalliOrg" },
						},
						sender: { login: "vinod" },
					},
				}),
			},
		);

		const response = await POST(request);
		const json = await response.json();

		expect(response.status).toBe(202);
		expect(json).toMatchObject({
			status: "accepted",
			source: "github",
			eventType: "issues",
			workflowId: "vajlzrprpie7fvco6ibhi",
			executionId: "exec-1",
		});
		expect(mockStartSupportedWorkflowExecution).toHaveBeenCalledWith({
			request,
			workflow: expect.objectContaining({
				id: "vajlzrprpie7fvco6ibhi",
				userId: "user-1",
			}),
			input: {
				owner: "PittampalliOrg",
				repo: "open-swe",
				issue_number: 11,
				title: "Fix issue",
				body: "Please fix",
				sender: "vinod",
			},
		});
	});

	it("accepts stringified payloads from Argo HTTP trigger parameterization", async () => {
		const request = new Request(
			"http://localhost/api/events/ingest?source=github&eventType=issues",
			{
				method: "POST",
				body: JSON.stringify({
					eventId: "evt-2",
					receivedAt: "2026-04-02T12:05:00Z",
					payload: JSON.stringify({
						action: "labeled",
						issue: {
							number: 12,
							title: "Fix issue from string payload",
							body: "Please fix from string payload",
							labels: [{ name: "dapr-swe" }],
						},
						repository: {
							name: "open-swe",
							owner: { login: "PittampalliOrg" },
						},
						sender: { login: "vinod" },
					}),
				}),
			},
		);

		const response = await POST(request);
		const json = await response.json();

		expect(response.status).toBe(202);
		expect(json).toMatchObject({
			status: "accepted",
			workflowId: "vajlzrprpie7fvco6ibhi",
			executionId: "exec-1",
		});
		expect(mockStartSupportedWorkflowExecution).toHaveBeenCalledWith({
			request,
			workflow: expect.objectContaining({
				id: "vajlzrprpie7fvco6ibhi",
				userId: "user-1",
			}),
			input: {
				owner: "PittampalliOrg",
				repo: "open-swe",
				issue_number: 12,
				title: "Fix issue from string payload",
				body: "Please fix from string payload",
				sender: "vinod",
			},
		});
	});
});

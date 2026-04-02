import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindFirst = vi.hoisted(() => vi.fn());
const mockExecutionFindMany = vi.hoisted(() => vi.fn());
const mockStartSupportedWorkflowExecution = vi.hoisted(() => vi.fn());

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

function signBody(body: string): string {
	return `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
}

describe("POST /api/webhooks/github", () => {
	beforeEach(() => {
		mockFindFirst.mockReset();
		mockExecutionFindMany.mockReset();
		mockStartSupportedWorkflowExecution.mockReset();
		process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
		delete process.env.GITHUB_WEBHOOK_TRIGGER_LABEL;

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

	it("rejects invalid signatures", async () => {
		const response = await POST(
			new Request("http://localhost/api/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GitHub-Event": "issues",
					"X-Hub-Signature-256": "sha256=bad",
				},
				body: JSON.stringify({ action: "opened" }),
			}),
		);

		expect(response.status).toBe(401);
		expect(mockStartSupportedWorkflowExecution).not.toHaveBeenCalled();
	});

	it("ignores unsupported GitHub events", async () => {
		const body = JSON.stringify({ action: "created" });
		const response = await POST(
			new Request("http://localhost/api/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GitHub-Event": "issue_comment",
					"X-Hub-Signature-256": signBody(body),
				},
				body,
			}),
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			status: "ignored",
			reason: "Unsupported GitHub event",
		});
		expect(mockStartSupportedWorkflowExecution).not.toHaveBeenCalled();
	});

	it("ignores issues without the trigger label", async () => {
		const body = JSON.stringify({
			action: "labeled",
			issue: {
				number: 1,
				title: "Fix bug",
				body: "Please fix",
				labels: [{ name: "bug" }],
			},
			repository: {
				name: "open-swe",
				owner: { login: "PittampalliOrg" },
			},
			sender: { login: "vinod" },
		});
		const response = await POST(
			new Request("http://localhost/api/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GitHub-Event": "issues",
					"X-Hub-Signature-256": signBody(body),
				},
				body,
			}),
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			status: "ignored",
			reason: "Issue does not have the trigger label",
		});
		expect(mockStartSupportedWorkflowExecution).not.toHaveBeenCalled();
	});

	it("starts the supported workflow for labeled issue events", async () => {
		const body = JSON.stringify({
			action: "labeled",
			issue: {
				number: 42,
				title: "Resolve issue",
				body: "Detailed description",
				labels: [{ name: "bug" }, { name: "dapr-swe" }],
			},
			repository: {
				name: "open-swe",
				owner: { login: "PittampalliOrg" },
			},
			sender: { login: "vinod" },
		});
		const request = new Request("http://localhost/api/webhooks/github", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-GitHub-Event": "issues",
				"X-Hub-Signature-256": signBody(body),
			},
			body,
		});

		const response = await POST(request);
		const json = await response.json();

		expect(response.status).toBe(202);
		expect(json).toMatchObject({
			status: "accepted",
			workflowId: "vajlzrprpie7fvco6ibhi",
			executionId: "exec-1",
			instanceId: "inst-1",
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
				issue_number: 42,
				title: "Resolve issue",
				body: "Detailed description",
				sender: "vinod",
			},
		});
	});

	it("ignores opened issue events even if the label is present", async () => {
		const body = JSON.stringify({
			action: "opened",
			issue: {
				number: 42,
				title: "Resolve issue",
				body: "Detailed description",
				labels: [{ name: "dapr-swe" }],
			},
			repository: {
				name: "open-swe",
				owner: { login: "PittampalliOrg" },
			},
			sender: { login: "vinod" },
		});
		const response = await POST(
			new Request("http://localhost/api/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GitHub-Event": "issues",
					"X-Hub-Signature-256": signBody(body),
				},
				body,
			}),
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			status: "ignored",
			reason: "Unsupported GitHub issue action",
		});
		expect(mockExecutionFindMany).not.toHaveBeenCalled();
		expect(mockStartSupportedWorkflowExecution).not.toHaveBeenCalled();
	});

	it("ignores duplicate issue deliveries while a matching run is active", async () => {
		mockExecutionFindMany.mockResolvedValue([
			{
				id: "exec-active",
				status: "running",
				input: {
					owner: "PittampalliOrg",
					repo: "open-swe",
					issue_number: 42,
				},
				output: null,
			},
		]);

		const body = JSON.stringify({
			action: "labeled",
			issue: {
				number: 42,
				title: "Resolve issue",
				body: "Detailed description",
				labels: [{ name: "dapr-swe" }],
			},
			repository: {
				name: "open-swe",
				owner: { login: "PittampalliOrg" },
			},
			sender: { login: "vinod" },
		});

		const response = await POST(
			new Request("http://localhost/api/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GitHub-Event": "issues",
					"X-Hub-Signature-256": signBody(body),
				},
				body,
			}),
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			status: "ignored",
			executionId: "exec-active",
			reason: "A workflow execution is already in progress for this issue",
		});
		expect(mockStartSupportedWorkflowExecution).not.toHaveBeenCalled();
	});

	it("ignores duplicate issue deliveries when a PR already exists", async () => {
		mockExecutionFindMany.mockResolvedValue([
			{
				id: "exec-pr",
				status: "success",
				input: {
					owner: "PittampalliOrg",
					repo: "open-swe",
					issue_number: 42,
				},
				output: {
					workflowOutput: {
						pr_url: "https://github.com/PittampalliOrg/open-swe/pull/12",
					},
				},
			},
		]);

		const body = JSON.stringify({
			action: "labeled",
			issue: {
				number: 42,
				title: "Resolve issue",
				body: "Detailed description",
				labels: [{ name: "dapr-swe" }],
			},
			repository: {
				name: "open-swe",
				owner: { login: "PittampalliOrg" },
			},
			sender: { login: "vinod" },
		});

		const response = await POST(
			new Request("http://localhost/api/webhooks/github", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-GitHub-Event": "issues",
					"X-Hub-Signature-256": signBody(body),
				},
				body,
			}),
		);

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toMatchObject({
			status: "ignored",
			executionId: "exec-pr",
			reason: "A workflow execution already created a PR for this issue",
		});
		expect(mockStartSupportedWorkflowExecution).not.toHaveBeenCalled();
	});
});

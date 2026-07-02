import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-child",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
	};
	const sessions = [
		{
			id: "session-child",
			title: "Child run",
			status: "running",
			agentId: "agent-1",
			workflowExecutionId: "exec-child",
			createdAt: new Date("2026-01-01T00:00:00.000Z"),
			completedAt: null,
		},
		{
			id: "session-parent",
			title: "Parent run",
			status: "completed",
			agentId: "agent-2",
			workflowExecutionId: "exec-parent",
			createdAt: new Date("2025-12-31T23:00:00.000Z"),
			completedAt: new Date("2025-12-31T23:05:00.000Z"),
		},
	];
	const workflowData = {
		getExecutionById: vi.fn(async () => execution),
		listExecutionSessions: vi.fn(async () => sessions),
	};
	return { execution, sessions, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-child" },
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("workflow execution sessions route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.workflowData.listExecutionSessions.mockResolvedValue(mocks.sessions);
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns direct and inherited sessions through workflow-data", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			sessions: [
				{
					id: "session-child",
					title: "Child run",
					status: "running",
					agentId: "agent-1",
					inherited: false,
					sourceExecutionId: null,
					createdAt: "2026-01-01T00:00:00.000Z",
					completedAt: null,
				},
				{
					id: "session-parent",
					title: "Parent run",
					status: "completed",
					agentId: "agent-2",
					inherited: true,
					sourceExecutionId: "exec-parent",
					createdAt: "2025-12-31T23:00:00.000Z",
					completedAt: "2025-12-31T23:05:00.000Z",
				},
			],
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-child");
		expect(mocks.workflowData.listExecutionSessions).toHaveBeenCalledWith({
			executionId: "exec-child",
			projectId: "project-1",
			includeAncestors: true,
		});
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.listExecutionSessions).not.toHaveBeenCalled();
	});
});

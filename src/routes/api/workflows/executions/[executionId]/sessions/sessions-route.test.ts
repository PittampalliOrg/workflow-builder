import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const body = {
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
		],
	};
	type ListSessionsResult =
		| { status: "ok"; body: typeof body }
		| { status: "error"; httpStatus: number; message: string };
	const workflowExecutionSessions = {
		listSessions: vi.fn(
			async (): Promise<ListSessionsResult> => ({ status: "ok", body }),
		),
	};
	return { body, workflowExecutionSessions };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionSessions: mocks.workflowExecutionSessions,
	}),
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
		mocks.workflowExecutionSessions.listSessions.mockResolvedValue({
			status: "ok",
			body: mocks.body,
		});
	});

	it("keeps the route behind workflow execution session application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionSessions.listSessions");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("$lib/server/workflows/project-scope");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns sessions from the application service", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual(mocks.body);
		expect(mocks.workflowExecutionSessions.listSessions).toHaveBeenCalledWith({
			executionId: "exec-child",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowExecutionSessions.listSessions.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});

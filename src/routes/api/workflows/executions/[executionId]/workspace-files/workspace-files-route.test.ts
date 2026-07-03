import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowExecutionWorkspace = {
		listWorkspaceFiles: vi.fn(
			async (): Promise<unknown> => ({
				status: "ok" as const,
				body: {
					entries: [{ path: "src/index.ts", type: "file", size: 42 }],
					truncated: false,
				},
			}),
		),
	};
	return { workflowExecutionWorkspace };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionWorkspace: mocks.workflowExecutionWorkspace,
	}),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
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

describe("workflow execution workspace-files route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionWorkspace");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("assertInScope");
		expect(source).not.toContain("juicefs-webdav");
	});

	it("lists the scoped workspace tree by Dapr instance id", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			entries: [{ path: "src/index.ts", type: "file", size: 42 }],
			truncated: false,
		});
		expect(
			mocks.workflowExecutionWorkspace.listWorkspaceFiles,
		).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("returns an empty tree when no workspace instance exists", async () => {
		mocks.workflowExecutionWorkspace.listWorkspaceFiles.mockResolvedValueOnce({
			status: "ok",
			body: { entries: [], truncated: false },
		});

		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			entries: [],
			truncated: false,
		});
	});

	it("maps application-service not-found responses", async () => {
		mocks.workflowExecutionWorkspace.listWorkspaceFiles.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});

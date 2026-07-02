import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const execution = {
		id: "exec-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		status: "running",
	};
	const outputFiles = {
		files: [
			{
				id: "file-1",
				name: "result.txt",
				contentType: "text/plain",
				sizeBytes: 42,
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
			},
		],
		liveSandbox: { name: "workspace-abc" },
		cliWorkspace: false,
	};
	const workflowData = {
		getExecutionById: vi.fn(async () => execution),
		listExecutionOutputFiles: vi.fn(async () => outputFiles),
	};
	return { execution, outputFiles, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
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

describe("workflow execution files route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.workflowData.listExecutionOutputFiles.mockResolvedValue(mocks.outputFiles);
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

	it("returns output files from workflow-data", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			files: [
				{
					id: "file-1",
					name: "result.txt",
					contentType: "text/plain",
					sizeBytes: 42,
					createdAt: "2026-01-01T00:00:00.000Z",
				},
			],
			liveSandbox: { name: "workspace-abc" },
			cliWorkspace: false,
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.workflowData.listExecutionOutputFiles).toHaveBeenCalledWith("exec-1");
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.workflowData.listExecutionOutputFiles).not.toHaveBeenCalled();
	});
});

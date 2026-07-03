import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
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
	const workflowExecutionFiles = {
		listOutputFiles: vi.fn(
			async (): Promise<unknown> => ({
				status: "ok" as const,
				body: outputFiles,
			}),
		),
	};
	return { outputFiles, workflowExecutionFiles };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowExecutionFiles: mocks.workflowExecutionFiles,
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

describe("workflow execution files route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowExecutionFiles");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("assertInScope");
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
		expect(mocks.workflowExecutionFiles.listOutputFiles).toHaveBeenCalledWith({
			executionId: "exec-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("maps application-service not-found responses", async () => {
		mocks.workflowExecutionFiles.listOutputFiles.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowExecutionWorkspace = {
		readWorkspaceFile: vi.fn(
			async (): Promise<unknown> => ({
				status: "ok" as const,
				body: {
					bytes: new TextEncoder().encode("hello").buffer,
					contentType: "text/plain",
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
		url: new URL(
			"http://localhost/api/workflows/executions/exec-1/workspace-content?path=src/index.ts",
		),
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

describe("workflow execution workspace-content route", () => {
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

	it("reads a scoped workspace file by Dapr instance id", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/plain");
		await expect(response.text()).resolves.toBe("hello");
		expect(
			mocks.workflowExecutionWorkspace.readWorkspaceFile,
		).toHaveBeenCalledWith({
			executionId: "exec-1",
			path: "src/index.ts",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("requires a relative path before reading execution data", async () => {
		const url = new URL(
			"http://localhost/api/workflows/executions/exec-1/workspace-content",
		);

		await expectHttpStatus(Promise.resolve(GET(event({ url }) as never)), 400);
		expect(
			mocks.workflowExecutionWorkspace.readWorkspaceFile,
		).not.toHaveBeenCalled();
	});

	it("maps application-service not-found responses", async () => {
		mocks.workflowExecutionWorkspace.readWorkspaceFile.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			message: "Execution not found",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});

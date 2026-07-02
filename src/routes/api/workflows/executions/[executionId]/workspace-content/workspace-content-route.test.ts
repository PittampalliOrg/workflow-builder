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
		daprInstanceId: "sw-example-exec-exec-1",
	};
	const workflowData = {
		getExecutionById: vi.fn(async () => execution),
	};
	const readWorkspaceFile = vi.fn(async () => ({
		bytes: new TextEncoder().encode("hello").buffer,
		contentType: "text/plain",
	}));
	return { execution, workflowData, readWorkspaceFile };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/workflows/juicefs-webdav", () => ({
	readWorkspaceFile: mocks.readWorkspaceFile,
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		url: new URL("http://localhost/api/workflows/executions/exec-1/workspace-content?path=src/index.ts"),
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
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.readWorkspaceFile.mockResolvedValue({
			bytes: new TextEncoder().encode("hello").buffer,
			contentType: "text/plain",
		});
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

	it("reads a scoped workspace file by Dapr instance id", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe("text/plain");
		await expect(response.text()).resolves.toBe("hello");
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.readWorkspaceFile).toHaveBeenCalledWith(
			"sw-example-exec-exec-1",
			"src/index.ts",
		);
	});

	it("requires a relative path before reading execution data", async () => {
		const url = new URL("http://localhost/api/workflows/executions/exec-1/workspace-content");

		await expectHttpStatus(Promise.resolve(GET(event({ url }) as never)), 400);
		expect(mocks.workflowData.getExecutionById).not.toHaveBeenCalled();
		expect(mocks.readWorkspaceFile).not.toHaveBeenCalled();
	});

	it("hides executions outside the active workspace", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.readWorkspaceFile).not.toHaveBeenCalled();
	});
});

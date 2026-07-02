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
	const readModel = {
		id: "exec-1",
		status: "running",
		phase: "running",
		progress: 50,
	};
	const loadExecutionReadModel = vi.fn(async () => readModel);
	const serializeExecutionReadModel = vi.fn((model) => ({ ...model, serialized: true }));
	return { execution, workflowData, loadExecutionReadModel, serializeExecutionReadModel };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/execution-read-model", () => ({
	loadExecutionReadModel: mocks.loadExecutionReadModel,
	serializeExecutionReadModel: mocks.serializeExecutionReadModel,
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		url: new URL("http://localhost/api/workflows/executions/exec-1/status"),
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

describe("workflow execution status route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getExecutionById.mockResolvedValue(mocks.execution);
		mocks.loadExecutionReadModel.mockResolvedValue({
			id: "exec-1",
			status: "running",
			phase: "running",
			progress: 50,
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

	it("pre-checks scope through workflow-data before loading the read model", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			id: "exec-1",
			status: "running",
			serialized: true,
		});
		expect(mocks.workflowData.getExecutionById).toHaveBeenCalledWith("exec-1");
		expect(mocks.loadExecutionReadModel).toHaveBeenCalledWith("exec-1", {
			refreshRuntime: true,
			includeAgentEvents: false,
		});
	});

	it("hides executions outside the active workspace before loading the model", async () => {
		mocks.workflowData.getExecutionById.mockResolvedValueOnce({
			...mocks.execution,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.loadExecutionReadModel).not.toHaveBeenCalled();
	});

	it("passes includeAgentEvents to the read-model serializer", async () => {
		const url = new URL("http://localhost/api/workflows/executions/exec-1/status");
		url.searchParams.set("includeAgentEvents", "true");

		const response = (await GET(event({ url }) as never)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.loadExecutionReadModel).toHaveBeenCalledWith("exec-1", {
			refreshRuntime: true,
			includeAgentEvents: true,
		});
		expect(mocks.serializeExecutionReadModel).toHaveBeenCalledWith(expect.anything(), {
			compact: false,
			includeAgentEvents: true,
		});
	});
});

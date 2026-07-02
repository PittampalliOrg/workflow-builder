import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflow = {
		id: "wf-1",
		name: "Example",
		userId: "user-1",
		projectId: "project-1",
		spec: { document: { dsl: "1.0.0", namespace: "default", name: "example" } },
	};
	const workflowData = {
		getWorkflowByRef: vi.fn(async () => workflow),
	};
	const emitWorkflow = vi.fn(async () => ({
		source: "export const workflow = {};",
		supportingFiles: [],
		warnings: [],
		compositionGraph: { nodes: [] },
		workflowName: "example",
		filename: "example.ts",
	}));
	const createCodeFunction = vi.fn(async () => ({
		id: "fn-1",
		slug: "example-workflow",
		name: "Example (workflow)",
	}));
	return { workflow, workflowData, emitWorkflow, createCodeFunction };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/workflows/code-emitter", () => ({
	emitWorkflow: mocks.emitWorkflow,
}));

vi.mock("$lib/server/code-functions", () => ({
	createCodeFunction: mocks.createCodeFunction,
}));

import { GET, POST } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { workflowId: "wf-1" },
		url: new URL("http://localhost/api/workflows/wf-1/export?format=json"),
		request: new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ name: "Saved workflow" }),
		}),
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

describe("workflow export route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
		mocks.emitWorkflow.mockResolvedValue({
			source: "export const workflow = {};",
			supportingFiles: [],
			warnings: [],
			compositionGraph: { nodes: [] },
			workflowName: "example",
			filename: "example.ts",
		});
		mocks.createCodeFunction.mockResolvedValue({
			id: "fn-1",
			slug: "example-workflow",
			name: "Example (workflow)",
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

	it("returns emitted workflow JSON", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			source: "export const workflow = {};",
			workflowName: "example",
			filename: "example.ts",
			language: "typescript",
		});
		expect(mocks.workflowData.getWorkflowByRef).toHaveBeenCalledWith({
			workflowId: "wf-1",
			lookup: "id",
		});
	});

	it("saves emitted code as a code function", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			codeFunctionId: "fn-1",
			slug: "example-workflow",
			name: "Example (workflow)",
		});
		expect(mocks.createCodeFunction).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Saved workflow",
				language: "typescript",
				role: "workflow",
			}),
			"user-1",
		);
	});

	it("hides workflows outside the active workspace", async () => {
		mocks.workflowData.getWorkflowByRef.mockResolvedValueOnce({
			...mocks.workflow,
			projectId: "project-2",
		});

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
		expect(mocks.emitWorkflow).not.toHaveBeenCalled();
	});
});

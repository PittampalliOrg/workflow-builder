import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const updated = {
		id: "wf-1",
		daprWorkflowName: "wf_wf-1",
	};
	const workflowDefinitionCommands = {
		publishWorkflow: vi.fn(),
	};
	return { updated, workflowDefinitionCommands };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowDefinitionCommands: mocks.workflowDefinitionCommands,
	}),
}));

import { POST } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { workflowId: "wf-1" },
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

describe("workflow publish route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowDefinitionCommands.publishWorkflow.mockResolvedValue({
			status: "ok",
			body: mocks.updated,
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowDefinitionCommands.publishWorkflow");
		expect(source).not.toContain("nanoid");
		expect(source).not.toContain("$lib/server/workflows/sw10-agent-validation");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("publishes through the workflow definition command service", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			id: "wf-1",
			daprWorkflowName: "wf_wf-1",
		});
		expect(mocks.workflowDefinitionCommands.publishWorkflow).toHaveBeenCalledWith({
			workflowId: "wf-1",
		});
	});

	it("returns 404 for missing workflows", async () => {
		mocks.workflowDefinitionCommands.publishWorkflow.mockResolvedValueOnce({
			status: "error",
			httpStatus: 404,
			body: "Workflow not found",
		});

		await expectHttpStatus(Promise.resolve(POST(event() as never)), 404);
	});
});

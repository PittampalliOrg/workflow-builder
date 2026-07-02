import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflow = { id: "wf-1", userId: "user-1", projectId: "project-1" };
	const trigger = { id: "trigger-1", workflowId: "wf-1" };
	const workflowData = {
		getWorkflowByRef: vi.fn(async () => workflow),
		getWorkflowTrigger: vi.fn(async () => trigger),
	};
	const activateWorkflowTrigger = vi.fn(async () => ({ ok: true, status: "active" }));
	return { workflow, trigger, workflowData, activateWorkflowTrigger };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/lifecycle/trigger-reconciler", () => ({
	activateWorkflowTrigger: mocks.activateWorkflowTrigger,
}));

import { POST } from "./+server";

describe("workflow trigger activate route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
		mocks.workflowData.getWorkflowTrigger.mockResolvedValue(mocks.trigger);
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

	it("activates a scoped trigger", async () => {
		const response = (await POST({
			params: { workflowId: "wf-1", triggerId: "trigger-1" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ success: true, status: "active" });
		expect(mocks.activateWorkflowTrigger).toHaveBeenCalledWith("trigger-1");
	});
});

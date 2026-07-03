import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowTriggerLifecycle = {
		activateTrigger: vi.fn(async () => ({
			status: "ok" as const,
			body: { success: true, status: "active" },
		}) as unknown),
	};
	return { workflowTriggerLifecycle };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowTriggerLifecycle: mocks.workflowTriggerLifecycle,
	}),
}));

import { POST } from "./+server";

describe("workflow trigger activate route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowTriggerLifecycle.activateTrigger.mockResolvedValue({
			status: "ok",
			body: { success: true, status: "active" },
		});
	});

	it("keeps the route behind the trigger lifecycle application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowTriggerLifecycle.activateTrigger");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/lifecycle/trigger-reconciler");
		expect(source).not.toContain("activateWorkflowTrigger");
		expect(source).not.toContain("isResourceInScope");
		expect(source).not.toContain("workflowData");
	});

	it("activates a scoped trigger", async () => {
		const response = (await POST({
			params: { workflowId: "wf-1", triggerId: "trigger-1" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ success: true, status: "active" });
		expect(mocks.workflowTriggerLifecycle.activateTrigger).toHaveBeenCalledWith({
			workflowId: "wf-1",
			triggerId: "trigger-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("preserves lifecycle error responses returned by the application service", async () => {
		mocks.workflowTriggerLifecycle.activateTrigger.mockResolvedValueOnce({
			status: "error",
			httpStatus: 502,
			body: { error: "activation failed" },
		});

		const response = (await POST({
			params: { workflowId: "wf-1", triggerId: "trigger-1" },
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never)) as Response;

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toEqual({ error: "activation failed" });
	});
});

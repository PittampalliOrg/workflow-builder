import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowTriggerLifecycle = {
		deleteTrigger: vi.fn(async () => ({
			status: "ok" as const,
			body: { success: true },
		})),
	};
	return { workflowTriggerLifecycle };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowTriggerLifecycle: mocks.workflowTriggerLifecycle,
	}),
}));

import { DELETE } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { workflowId: "wf-1", triggerId: "trigger-1" },
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

describe("workflow trigger item route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowTriggerLifecycle.deleteTrigger.mockResolvedValue({
			status: "ok",
			body: { success: true },
		});
	});

	it("keeps the route behind the trigger lifecycle application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowTriggerLifecycle.deleteTrigger");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/lifecycle/trigger-reconciler");
		expect(source).not.toContain("deactivateWorkflowTrigger");
		expect(source).not.toContain("isResourceInScope");
		expect(source).not.toContain("workflowData");
	});

	it("deletes a scoped trigger through the application service", async () => {
		const response = (await DELETE(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ success: true });
		expect(mocks.workflowTriggerLifecycle.deleteTrigger).toHaveBeenCalledWith({
			workflowId: "wf-1",
			triggerId: "trigger-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflow = { id: "wf-1", userId: "user-1", projectId: "project-1" };
	const trigger = {
		id: "trigger-1",
		workflowId: "wf-1",
		userId: "user-1",
		projectId: "project-1",
		kind: "manual",
		config: { visible: true, __secret: "hidden" },
		triggerData: null,
		dedupSalt: "salt",
		backingRef: null,
		status: "inactive",
		lastError: null,
		lastFiredAt: null,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
	const workflowData = {
		getWorkflowByRef: vi.fn(async () => workflow),
		listWorkflowTriggers: vi.fn(async () => [trigger]),
		createWorkflowTrigger: vi.fn(async () => trigger),
	};
	return { workflow, trigger, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/utils/id", () => ({
	generateId: () => "salt",
}));

import { GET, POST } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { workflowId: "wf-1" },
		request: new Request("http://localhost", {
			method: "POST",
			body: JSON.stringify({ kind: "manual", config: { visible: true } }),
		}),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

describe("workflow triggers route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.getWorkflowByRef.mockResolvedValue(mocks.workflow);
		mocks.workflowData.listWorkflowTriggers.mockResolvedValue([mocks.trigger]);
		mocks.workflowData.createWorkflowTrigger.mockResolvedValue(mocks.trigger);
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

	it("lists sanitized triggers", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			triggers: [{ id: "trigger-1", config: { visible: true } }],
		});
		expect(mocks.workflowData.listWorkflowTriggers).toHaveBeenCalledWith("wf-1");
	});

	it("creates a trigger through workflow-data", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(201);
		expect(mocks.workflowData.createWorkflowTrigger).toHaveBeenCalledWith({
			workflowId: "wf-1",
			userId: "user-1",
			projectId: "project-1",
			kind: "manual",
			config: { visible: true },
			triggerData: null,
			dedupSalt: "salt",
			status: "inactive",
		});
	});
});

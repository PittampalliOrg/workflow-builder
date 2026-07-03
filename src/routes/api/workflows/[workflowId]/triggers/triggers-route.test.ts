import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowTriggerManagement = {
		listTriggers: vi.fn(async () => ({
			status: "ok" as const,
			body: { triggers: [{ id: "trigger-1", config: { visible: true } }] },
		}) as unknown),
		createTrigger: vi.fn(async () => ({
			status: "ok" as const,
			httpStatus: 201,
			body: { trigger: { id: "trigger-1", config: { visible: true } } },
		}) as unknown),
	};
	return { workflowTriggerManagement };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowTriggerManagement: mocks.workflowTriggerManagement,
	}),
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
		mocks.workflowTriggerManagement.listTriggers.mockResolvedValue({
			status: "ok",
			body: { triggers: [{ id: "trigger-1", config: { visible: true } }] },
		});
		mocks.workflowTriggerManagement.createTrigger.mockResolvedValue({
			status: "ok",
			httpStatus: 201,
			body: { trigger: { id: "trigger-1", config: { visible: true } } },
		});
	});

	it("keeps the route behind workflow trigger management application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowTriggerManagement.listTriggers");
		expect(source).toContain("workflowTriggerManagement.createTrigger");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflowData");
		expect(source).not.toContain("getTriggerKind");
		expect(source).not.toContain("validateTriggerConfig");
		expect(source).not.toContain("generateId");
		expect(source).not.toContain("isResourceInScope");
	});

	it("lists sanitized triggers", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			triggers: [{ id: "trigger-1", config: { visible: true } }],
		});
		expect(mocks.workflowTriggerManagement.listTriggers).toHaveBeenCalledWith({
			workflowId: "wf-1",
			userId: "user-1",
			projectId: "project-1",
		});
	});

	it("creates a trigger through the application service", async () => {
		const response = (await POST(event() as never)) as Response;

		expect(response.status).toBe(201);
		expect(mocks.workflowTriggerManagement.createTrigger).toHaveBeenCalledWith({
			workflowId: "wf-1",
			userId: "user-1",
			projectId: "project-1",
			body: { kind: "manual", config: { visible: true } },
		});
	});

	it("preserves application-service error responses", async () => {
		mocks.workflowTriggerManagement.createTrigger.mockResolvedValueOnce({
			status: "error",
			httpStatus: 400,
			body: "Unknown trigger kind: undefined",
		});

		await expect(POST(event() as never)).rejects.toMatchObject({
			status: 400,
			body: { message: "Unknown trigger kind: undefined" },
		});
	});
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const activeExecutions = [
		{
			id: "exec-1",
			workflowId: "wf-1",
			status: "running",
		},
	];
	const workflowData = {
		listActiveWorkflowExecutionsForUser: vi.fn(async () => activeExecutions),
	};
	const authSession = {
		getSession: vi.fn(async () => ({
			user: { id: "user-1" },
		})),
	};
	return { activeExecutions, workflowData, authSession };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		workflowData: mocks.workflowData,
		authSession: mocks.authSession,
	}),
}));

import { GET } from "./+server";

describe("active workflow executions route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.authSession.getSession.mockResolvedValue({
			user: { id: "user-1" },
		});
		mocks.workflowData.listActiveWorkflowExecutionsForUser.mockResolvedValue(
			mocks.activeExecutions,
		);
	});

	it("keeps active execution reads behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.listActiveWorkflowExecutionsForUser");
		expect(source).toContain("authSession.getSession");
		expect(source).not.toMatch(/from ['"]\$lib\/server\/auth['"]/);
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflowExecutions");
		expect(source).not.toContain("workflows");
	});

	it("loads active executions for the authenticated user", async () => {
		const request = new Request("http://localhost/api/workflow/active-executions");
		const response = (await GET({ request, cookies: {} } as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual(mocks.activeExecutions);
		expect(mocks.authSession.getSession).toHaveBeenCalledWith({
			request,
			cookies: {},
		});
		expect(mocks.workflowData.listActiveWorkflowExecutionsForUser).toHaveBeenCalledWith(
			"user-1",
		);
	});
});

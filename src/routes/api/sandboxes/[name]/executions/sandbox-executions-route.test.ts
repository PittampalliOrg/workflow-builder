import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		listSandboxExecutions: vi.fn(async () => [
			{
				executionId: "exec-1",
				workflowId: "wf-1",
				workflowName: "Example",
				status: "completed",
				startedAt: "2026-07-01T00:00:00.000Z",
				completedAt: null,
			},
		]),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

describe("sandbox executions route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps sandbox execution reads behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.listSandboxExecutions");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	it("passes sandbox name to workflow-data", async () => {
		const response = (await GET({
			params: { name: "dapr-agent-py" },
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual([
			{
				executionId: "exec-1",
				workflowId: "wf-1",
				workflowName: "Example",
				status: "completed",
				startedAt: "2026-07-01T00:00:00.000Z",
				completedAt: null,
			},
		]);
		expect(mocks.workflowData.listSandboxExecutions).toHaveBeenCalledWith(
			"dapr-agent-py",
		);
	});
});

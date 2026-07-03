import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const runs = [
		{
			executionId: "exec-1",
			workflowId: "wf-1",
			workflowName: "Example",
			status: "running",
			startedAt: "2026-01-01T00:00:00.000Z",
			completedAt: null,
			durationMs: null,
			sessionCount: 1,
			agents: [],
		},
	];
	const workflowData = {
		listProjectWorkflowRuns: vi.fn(async () => runs),
	};
	return { runs, workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

function event(search = "") {
	return {
		url: new URL(`http://workflow-builder.local/api/v1/runs${search}`),
		locals: {
			session: {
				userId: "user-1",
				projectId: "project-1",
			},
		},
	};
}

describe("project workflow runs route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.workflowData.listProjectWorkflowRuns.mockResolvedValue(mocks.runs);
	});

	it("keeps project run reads behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.listProjectWorkflowRuns");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("$lib/server/workflows/runs");
		expect(source).not.toContain("drizzle-orm");
	});

	it("lists project-scoped workflow runs through workflowData", async () => {
		const response = (await GET(
			event(
				"?workflowId=wf-1&status=running&since=2026-01-01T00%3A00%3A00.000Z&q=Example&limit=10",
			) as never,
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ runs: mocks.runs });
		expect(mocks.workflowData.listProjectWorkflowRuns).toHaveBeenCalledWith({
			projectId: "project-1",
			workflowId: "wf-1",
			status: "running",
			since: new Date("2026-01-01T00:00:00.000Z"),
			q: "Example",
			limit: 10,
		});
	});

	it("returns an empty list when the authenticated request has no project scope", async () => {
		const response = (await GET({
			...event(),
			locals: { session: { userId: "user-1", projectId: null } },
		} as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ runs: [] });
		expect(mocks.workflowData.listProjectWorkflowRuns).not.toHaveBeenCalled();
	});
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		listWorkflowBrowserArtifactsByExecutionId: vi.fn(async () => [
			{
				id: "bwf_1",
				workflowExecutionId: "exec-1",
				workflowId: "wf-1",
				nodeId: "browser",
				artifactType: "capture_flow_v1",
				artifactVersion: 1,
				status: "completed",
				manifestJson: {},
				createdAt: new Date("2026-01-01T00:00:00.000Z"),
				updatedAt: new Date("2026-01-01T00:00:00.000Z"),
			},
		]),
	};
	return { workflowData };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

import { GET } from "./+server";

describe("workflow execution browser artifacts route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.listWorkflowBrowserArtifactsByExecutionId");
		expect(source).not.toContain("$lib/server/browser-artifacts");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("lists browser artifacts through workflowData", async () => {
		const response = (await GET({ params: { executionId: "exec-1" } } as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			artifacts: [{ id: "bwf_1", workflowExecutionId: "exec-1" }],
		});
		expect(mocks.workflowData.listWorkflowBrowserArtifactsByExecutionId).toHaveBeenCalledWith(
			"exec-1",
		);
	});
});

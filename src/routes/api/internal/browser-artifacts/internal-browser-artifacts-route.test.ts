import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const workflowData = {
		saveWorkflowBrowserArtifact: vi.fn(async () => ({ id: "bwf_1" })),
	};
	const validateInternalToken = vi.fn(() => true);
	return { workflowData, validateInternalToken };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ workflowData: mocks.workflowData }),
}));

vi.mock("$lib/server/internal-auth", () => ({
	validateInternalToken: mocks.validateInternalToken,
}));

import { POST } from "./+server";

describe("internal browser artifacts route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validateInternalToken.mockReturnValue(true);
		mocks.workflowData.saveWorkflowBrowserArtifact.mockResolvedValue({ id: "bwf_1" });
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.saveWorkflowBrowserArtifact");
		expect(source).not.toContain("$lib/server/browser-artifacts");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("saves browser artifacts through workflowData", async () => {
		const request = new Request("http://test/api/internal/browser-artifacts", {
			method: "POST",
			body: JSON.stringify({
				workflowExecutionId: "exec-1",
				workflowId: "wf-1",
				nodeId: "browser",
				baseUrl: "https://example.test",
				steps: [{ id: "step-1", label: "Open", url: "https://example.test" }],
				screenshots: [
					{
						payloadBase64: "aGVsbG8=",
						label: "Shot",
						storageRef: "workflow-browser-artifacts/foreign/ref.png",
					},
				],
			}),
		});

		const response = (await POST({ request } as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			success: true,
			artifact: { id: "bwf_1" },
		});
		expect(mocks.workflowData.saveWorkflowBrowserArtifact).toHaveBeenCalledWith(
				expect.objectContaining({
					workflowExecutionId: "exec-1",
					workflowId: "wf-1",
					nodeId: "browser",
					status: "completed",
					screenshots: [
						expect.not.objectContaining({ storageRef: expect.anything() }),
					],
				}),
			);
	});

	it("rejects requests without the internal token", async () => {
		mocks.validateInternalToken.mockReturnValueOnce(false);
		const request = new Request("http://test/api/internal/browser-artifacts", {
			method: "POST",
			body: "{}",
		});

		const response = (await POST({ request } as never)) as Response;

		expect(response.status).toBe(401);
		expect(mocks.workflowData.saveWorkflowBrowserArtifact).not.toHaveBeenCalled();
	});
});

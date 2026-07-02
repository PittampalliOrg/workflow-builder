import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSessionBrowserService } from "$lib/server/application/session-browser";
import type { BrowserRuntimeClient } from "$lib/server/application/ports";

describe("ApplicationSessionBrowserService", () => {
	const workflowData = {
		getSessionBrowserTarget: vi.fn(
			async (): Promise<{ sessionId: string; agentSlug: string } | null> => ({
				sessionId: "session-1",
				agentSlug: "browser-agent",
			}),
		),
	};
	const browserRuntime = {
		getState: vi.fn(async () => ({
			pageUrl: "https://example.test",
			pageTitle: "Example",
			consoleTail: [{ level: "info", text: "ready" }],
		})),
		takeScreenshot: vi.fn(
			async (): Promise<{ jpeg: Uint8Array } | null> => ({ jpeg: Buffer.from("jpeg") }),
		),
	} satisfies BrowserRuntimeClient;
	const service = new ApplicationSessionBrowserService({
		workflowData,
		browserRuntime,
		now: () => new Date("2026-01-01T00:00:00.000Z"),
	});

	beforeEach(() => {
		vi.clearAllMocks();
		workflowData.getSessionBrowserTarget.mockResolvedValue({
			sessionId: "session-1",
			agentSlug: "browser-agent",
		});
		browserRuntime.getState.mockResolvedValue({
			pageUrl: "https://example.test",
			pageTitle: "Example",
			consoleTail: [{ level: "info", text: "ready" }],
		});
		browserRuntime.takeScreenshot.mockResolvedValue({ jpeg: Buffer.from("jpeg") });
	});

	it("resolves browser state through workflow-data and the browser runtime port", async () => {
		await expect(
			service.getState({ sessionId: "session-1", projectId: "project-1" }),
		).resolves.toEqual({
			status: "ok",
			data: {
				pageUrl: "https://example.test",
				pageTitle: "Example",
				consoleTail: [{ level: "info", text: "ready" }],
				lastUpdatedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		expect(workflowData.getSessionBrowserTarget).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});
		expect(browserRuntime.getState).toHaveBeenCalledWith({
			agentSlug: "browser-agent",
		});
	});

	it("does not call the browser runtime when the session target is missing", async () => {
		workflowData.getSessionBrowserTarget.mockResolvedValueOnce(null);

		await expect(
			service.takeScreenshot({ sessionId: "missing", projectId: "project-1" }),
		).resolves.toEqual({ status: "not_found" });
		expect(browserRuntime.takeScreenshot).not.toHaveBeenCalled();
	});

	it("maps null browser transport results to not_ready", async () => {
		browserRuntime.takeScreenshot.mockResolvedValueOnce(null);

		await expect(
			service.takeScreenshot({ sessionId: "session-1", projectId: "project-1" }),
		).resolves.toEqual({ status: "not_ready" });
	});

	it("returns screenshot bytes through the browser runtime port", async () => {
		await expect(
			service.takeScreenshot({ sessionId: "session-1", projectId: "project-1" }),
		).resolves.toMatchObject({
			status: "ok",
			data: { contentType: "image/jpeg" },
		});
		expect(browserRuntime.takeScreenshot).toHaveBeenCalledWith({
			agentSlug: "browser-agent",
		});
	});
});

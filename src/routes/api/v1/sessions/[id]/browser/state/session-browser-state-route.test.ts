import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const sessionBrowser = {
		getState: vi.fn(
			async (): Promise<
				| {
						status: "ok";
						data: {
							pageUrl: string | null;
							pageTitle: string | null;
							consoleTail: Array<{ level: string; text: string }>;
							lastUpdatedAt: string;
						};
				  }
				| { status: "not_found" }
				| { status: "not_ready" }
			> => ({
				status: "ok",
				data: {
					pageUrl: "https://example.test",
					pageTitle: "Example",
					consoleTail: [{ level: "info", text: "ready" }],
					lastUpdatedAt: "2026-01-01T00:00:00.000Z",
				},
			}),
		),
	};
	return { sessionBrowser };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ sessionBrowser: mocks.sessionBrowser }),
}));

import { GET } from "./+server";

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { id: "session-1" },
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		...overrides,
	};
}

async function expectHttpStatus(promise: Promise<unknown>, status: number) {
	try {
		const result = await promise;
		expect((result as { status?: number }).status).toBe(status);
	} catch (err) {
		expect((err as { status?: number }).status).toBe(status);
	}
}

describe("session browser state route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.sessionBrowser.getState.mockResolvedValue({
			status: "ok",
			data: {
				pageUrl: "https://example.test",
				pageTitle: "Example",
				consoleTail: [{ level: "info", text: "ready" }],
				lastUpdatedAt: "2026-01-01T00:00:00.000Z",
			},
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("sessionBrowser.getState");
		expect(source).not.toContain("playwright-mcp-client");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns the browser state for the scoped session target", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			pageUrl: "https://example.test",
			pageTitle: "Example",
			consoleTail: [{ level: "info", text: "ready" }],
			lastUpdatedAt: "2026-01-01T00:00:00.000Z",
		});
		expect(mocks.sessionBrowser.getState).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});
	});

	it("returns 503 while the browser is not ready", async () => {
		mocks.sessionBrowser.getState.mockResolvedValueOnce({ status: "not_ready" });

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 503);
	});
});

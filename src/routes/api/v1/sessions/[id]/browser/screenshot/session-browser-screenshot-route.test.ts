import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const sessionBrowser = {
		takeScreenshot: vi.fn(
			async (): Promise<
				| {
						status: "ok";
						data: { jpeg: Uint8Array; contentType: "image/jpeg" };
				  }
				| { status: "not_found" }
				| { status: "not_ready" }
			> => ({
				status: "ok",
				data: { jpeg: Buffer.from("jpeg"), contentType: "image/jpeg" },
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

describe("session browser screenshot route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.sessionBrowser.takeScreenshot.mockResolvedValue({
			status: "ok",
			data: { jpeg: Buffer.from("jpeg"), contentType: "image/jpeg" },
		});
	});

	it("keeps the route behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("sessionBrowser.takeScreenshot");
		expect(source).not.toContain("playwright-mcp-client");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("streams the browser screenshot for the scoped session target", async () => {
		const response = (await GET(event() as never)) as Response;

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/jpeg");
		expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("jpeg");
		expect(mocks.sessionBrowser.takeScreenshot).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
		});
	});

	it("hides sessions outside the workspace", async () => {
		mocks.sessionBrowser.takeScreenshot.mockResolvedValueOnce({ status: "not_found" });

		await expectHttpStatus(Promise.resolve(GET(event() as never)), 404);
	});
});

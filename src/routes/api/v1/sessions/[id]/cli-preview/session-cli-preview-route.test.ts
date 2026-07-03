import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const cliPreview = {
		startSessionPreview: vi.fn(async () => ({
			status: "ok" as const,
			body: {
				ready: true,
				port: 5173,
				cwd: "/repo",
				proxyUrl: "http://localhost/proxy/",
				log: "ready",
			},
		})),
	};
	return { cliPreview };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		cliPreview: mocks.cliPreview,
	}),
}));

import { POST } from "./+server";

describe("session CLI preview route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.cliPreview.startSessionPreview.mockResolvedValue({
			status: "ok",
			body: {
				ready: true,
				port: 5173,
				cwd: "/repo",
				proxyUrl: "http://localhost/proxy/",
				log: "ready",
			},
		});
	});

	it("delegates preview start to the application service", async () => {
		const response = (await POST(
			event({
				request: new Request("http://localhost/api/v1/sessions/session-1/cli-preview", {
					method: "POST",
					body: JSON.stringify({ port: 5173, cwd: "/repo" }),
				}),
			}),
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ready: true,
			port: 5173,
			cwd: "/repo",
			proxyUrl: "http://localhost/proxy/",
			log: "ready",
		});
		expect(mocks.cliPreview.startSessionPreview).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			origin: "http://localhost",
			body: { port: 5173, cwd: "/repo" },
		});
	});

	it("keeps direct CLI preview infrastructure helpers out of the route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("cliPreview.startSessionPreview");
		expect(source).not.toContain("$lib/server/sessions/cli-preview");
		expect(source).not.toContain("resolveCliPreviewTarget");
		expect(source).not.toContain("startCliPreview");
		expect(source).not.toContain("CLI_PREVIEW_DEFAULT_PORT");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { id: "session-1" },
		request: new Request("http://localhost/api/v1/sessions/session-1/cli-preview", {
			method: "POST",
		}),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		url: new URL("http://localhost/api/v1/sessions/session-1/cli-preview"),
		...overrides,
	} as never;
}

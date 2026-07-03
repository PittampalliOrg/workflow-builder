import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const response = new Response("proxied", { status: 203 });
	const cliPreview = {
		proxySessionPreview: vi.fn(async () => ({
			status: "response" as const,
			response,
		})),
	};
	return { cliPreview, response };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		cliPreview: mocks.cliPreview,
	}),
}));

import { GET } from "./+server";

describe("session CLI preview proxy route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.cliPreview.proxySessionPreview.mockResolvedValue({
			status: "response",
			response: mocks.response,
		});
	});

	it("delegates preview proxy traffic to the application service", async () => {
		const request = new Request(
			"http://localhost/api/v1/sessions/session-1/cli-preview/view/assets/app.js?port=5173&v=1",
		);
		const url = new URL(request.url);
		const response = (await GET(event({ request, url }))) as Response;

		expect(response.status).toBe(203);
		await expect(response.text()).resolves.toBe("proxied");
		expect(mocks.cliPreview.proxySessionPreview).toHaveBeenCalledWith({
			sessionId: "session-1",
			projectId: "project-1",
			request,
			url,
			path: "assets/app.js",
		});
	});

	it("keeps direct CLI preview infrastructure helpers out of the proxy route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("cliPreview.proxySessionPreview");
		expect(source).not.toContain("$lib/server/sessions/cli-preview");
		expect(source).not.toContain("resolveCliPreviewTarget");
		expect(source).not.toContain("proxyCliPreview");
		expect(source).not.toContain("CLI_PREVIEW_DEFAULT_PORT");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

function event(overrides: Record<string, unknown> = {}) {
	const request = new Request(
		"http://localhost/api/v1/sessions/session-1/cli-preview/view/",
	);
	return {
		params: { id: "session-1", path: "assets/app.js" },
		request,
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		url: new URL(request.url),
		...overrides,
	} as never;
}

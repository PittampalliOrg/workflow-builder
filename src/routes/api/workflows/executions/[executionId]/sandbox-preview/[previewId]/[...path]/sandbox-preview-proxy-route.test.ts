import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const response = new Response("proxied", { status: 203 });
	const sandboxPreview = {
		proxyExecutionSandboxPreview: vi.fn(async () => ({
			status: "response" as const,
			response,
		})),
	};
	return { sandboxPreview, response };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		sandboxPreview: mocks.sandboxPreview,
	}),
}));

import { GET } from "./+server";

describe("execution sandbox preview proxy route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.sandboxPreview.proxyExecutionSandboxPreview.mockResolvedValue({
			status: "response",
			response: mocks.response,
		});
	});

	it("delegates preview proxy traffic to the application service", async () => {
		const request = new Request(
			"http://localhost/api/workflows/executions/exec-1/sandbox-preview/preview-1/assets/app.js?x=1",
		);
		const url = new URL(request.url);
		const response = (await GET(event({ request, url }))) as Response;

		expect(response.status).toBe(203);
		await expect(response.text()).resolves.toBe("proxied");
		expect(
			mocks.sandboxPreview.proxyExecutionSandboxPreview,
		).toHaveBeenCalledWith({
			executionId: "exec-1",
			previewId: "preview-1",
			path: "assets/app.js",
			request,
			url,
		});
	});

	it("keeps direct sandbox preview infrastructure helpers out of the proxy route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("sandboxPreview.proxyExecutionSandboxPreview");
		expect(source).not.toContain("$lib/server/workflows/sandbox-preview");
		expect(source).not.toContain("$lib/server/openshell-runtime");
		expect(source).not.toContain("rewriteHtmlBody");
		expect(source).not.toContain("FORWARDED_HEADERS");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

function event(overrides: Record<string, unknown> = {}) {
	const request = new Request(
		"http://localhost/api/workflows/executions/exec-1/sandbox-preview/preview-1/",
	);
	return {
		params: {
			executionId: "exec-1",
			previewId: "preview-1",
			path: "assets/app.js",
		},
		request,
		url: new URL(request.url),
		...overrides,
	} as never;
}

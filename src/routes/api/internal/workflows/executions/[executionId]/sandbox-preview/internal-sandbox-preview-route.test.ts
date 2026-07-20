import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requirePreviewActionInternal: vi.fn(),
	startExecutionSandboxPreview: vi.fn(async () => ({
		status: "ok" as const,
		body: {
			success: true,
			previewId: "preview-1",
			proxyUrl:
				"https://workflow-builder.example/api/workflows/executions/exec-1/sandbox-preview/preview-1/",
		},
	})),
}));

vi.mock("$lib/server/internal-auth", () => ({
	requirePreviewActionInternal: mocks.requirePreviewActionInternal,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		sandboxPreview: {
			startExecutionSandboxPreview: mocks.startExecutionSandboxPreview,
		},
	}),
}));

import { POST } from "./+server";

describe("internal execution sandbox preview route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("authenticates and delegates preview start to the application service", async () => {
		const request = new Request(
			"http://workflow-builder/api/internal/workflows/executions/exec-1/sandbox-preview",
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-preview-action-token": "purpose-token",
				},
				body: JSON.stringify({ previewId: "preview-1" }),
			},
		);
		const url = new URL(request.url);
		const response = (await POST({
			params: { executionId: "exec-1" },
			request,
			url,
		} as never)) as Response;

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(mocks.requirePreviewActionInternal).toHaveBeenCalledWith(request);
		expect(mocks.startExecutionSandboxPreview).toHaveBeenCalledWith({
			executionId: "exec-1",
			request,
			fallbackUrl: url,
			body: { previewId: "preview-1" },
		});
		await expect(response.json()).resolves.toMatchObject({
			success: true,
			previewId: "preview-1",
			proxyUrl: expect.stringContaining(
				"/api/workflows/executions/exec-1/sandbox-preview/preview-1/",
			),
		});
	});

	it("keeps runtime and persistence details behind application ports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("sandboxPreview.startExecutionSandboxPreview");
		expect(source).toContain("requirePreviewActionInternal");
		expect(source).not.toContain("$lib/server/openshell-runtime");
		expect(source).not.toContain("$lib/server/workflows/sandbox-preview");
		expect(source).not.toContain("$lib/server/app-url");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

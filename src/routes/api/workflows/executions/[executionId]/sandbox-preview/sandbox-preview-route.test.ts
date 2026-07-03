import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const sandboxPreview = {
		startExecutionSandboxPreview: vi.fn(async () => ({
			status: "ok" as const,
			body: { success: true, previewId: "preview-1" },
		})),
		stopExecutionSandboxPreview: vi.fn(async () => ({
			status: "ok" as const,
			body: { success: true, stopped: true },
		})),
	};
	return { sandboxPreview };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		sandboxPreview: mocks.sandboxPreview,
	}),
}));

import { DELETE, POST } from "./+server";

describe("execution sandbox preview route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.sandboxPreview.startExecutionSandboxPreview.mockResolvedValue({
			status: "ok",
			body: { success: true, previewId: "preview-1" },
		});
		mocks.sandboxPreview.stopExecutionSandboxPreview.mockResolvedValue({
			status: "ok",
			body: { success: true, stopped: true },
		});
	});

	it("delegates preview start to the application service", async () => {
		const request = new Request(
			"http://localhost/api/workflows/executions/exec-1/sandbox-preview",
			{
				method: "POST",
				body: JSON.stringify({ previewId: "preview-1" }),
			},
		);
		const url = new URL(request.url);
		const response = (await POST(event({ request, url }))) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			success: true,
			previewId: "preview-1",
		});
		expect(
			mocks.sandboxPreview.startExecutionSandboxPreview,
		).toHaveBeenCalledWith({
			executionId: "exec-1",
			request,
			fallbackUrl: url,
			body: { previewId: "preview-1" },
		});
	});

	it("delegates preview stop to the application service", async () => {
		const request = new Request(
			"http://localhost/api/workflows/executions/exec-1/sandbox-preview?previewId=preview-1",
			{ method: "DELETE" },
		);
		const response = (await DELETE(
			event({ request, url: new URL(request.url) }),
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			success: true,
			stopped: true,
		});
		expect(mocks.sandboxPreview.stopExecutionSandboxPreview).toHaveBeenCalledWith(
			{
				executionId: "exec-1",
				previewId: "preview-1",
			},
		);
	});

	it("keeps direct sandbox preview infrastructure helpers out of the route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("sandboxPreview.startExecutionSandboxPreview");
		expect(source).toContain("sandboxPreview.stopExecutionSandboxPreview");
		expect(source).not.toContain("$lib/server/workflows/sandbox-preview");
		expect(source).not.toContain("$lib/server/workflows/runtime-preview-url");
		expect(source).not.toContain("$lib/server/openshell-runtime");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

function event(overrides: Record<string, unknown> = {}) {
	const request = new Request(
		"http://localhost/api/workflows/executions/exec-1/sandbox-preview",
	);
	return {
		params: { executionId: "exec-1" },
		request,
		url: new URL(request.url),
		...overrides,
	} as never;
}

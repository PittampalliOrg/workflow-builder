import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const cliPreview = {
		startExecutionPreview: vi.fn(),
	};
	return { cliPreview };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		cliPreview: mocks.cliPreview,
	}),
}));

import { POST } from "./+server";

describe("execution CLI preview route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.cliPreview.startExecutionPreview.mockResolvedValue({
			status: "ok",
			body: {
				ready: true,
				port: 5173,
				cwd: "/repo",
				reused: true,
				sharedWorkspaceKey: "exec-key",
				proxyUrl: "http://localhost/proxy/",
				log: "ready",
			},
		});
	});

	it("delegates execution preview start to the application service", async () => {
		const response = (await POST(
			event({
				request: new Request(
					"http://localhost/api/workflows/executions/exec-1/cli-preview",
					{
						method: "POST",
						body: JSON.stringify({ port: 5173, cwd: "/repo" }),
					},
				),
			}),
		)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			ready: true,
			port: 5173,
			cwd: "/repo",
			reused: true,
			sharedWorkspaceKey: "exec-key",
			proxyUrl: "http://localhost/proxy/",
			log: "ready",
		});
		expect(mocks.cliPreview.startExecutionPreview).toHaveBeenCalledWith({
			executionId: "exec-1",
			projectId: "project-1",
			origin: "http://localhost",
			body: { port: 5173, cwd: "/repo" },
		});
	});

	it("preserves application-provided provisioning status", async () => {
		mocks.cliPreview.startExecutionPreview.mockResolvedValueOnce({
			status: "ok",
			httpStatus: 202,
			body: {
				ready: false,
				provisioning: true,
				message: "Preview pod is starting - retry shortly.",
			},
		});

		const response = (await POST(event())) as Response;

		expect(response.status).toBe(202);
		await expect(response.json()).resolves.toEqual({
			ready: false,
			provisioning: true,
			message: "Preview pod is starting - retry shortly.",
		});
	});

	it("keeps direct CLI preview infrastructure helpers out of the route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("cliPreview.startExecutionPreview");
		expect(source).not.toContain("$lib/server/sessions/cli-preview");
		expect(source).not.toContain("resolveExecutionCliPreviewTarget");
		expect(source).not.toContain("startCliPreview");
		expect(source).not.toContain("CLI_PREVIEW_DEFAULT_PORT");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

function event(overrides: Record<string, unknown> = {}) {
	return {
		params: { executionId: "exec-1" },
		request: new Request(
			"http://localhost/api/workflows/executions/exec-1/cli-preview",
			{ method: "POST" },
		),
		locals: { session: { userId: "user-1", projectId: "project-1" } },
		url: new URL("http://localhost/api/workflows/executions/exec-1/cli-preview"),
		...overrides,
	} as never;
}

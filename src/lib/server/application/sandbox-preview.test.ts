import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSandboxPreviewService } from "$lib/server/application/sandbox-preview";
import type {
	SandboxPreviewGatewayPort,
	WorkflowDataService,
} from "$lib/server/application/ports";

describe("ApplicationSandboxPreviewService", () => {
	let preview: SandboxPreviewGatewayPort;
	let workflowData: Pick<WorkflowDataService, "getExecutionWorkspaceRoute">;
	let service: ApplicationSandboxPreviewService;

	beforeEach(() => {
		preview = {
			getSandboxPreviewInfo: vi.fn(async () => ({
				executionId: "exec-1",
				workspaceRef: "workspace-1",
				sandboxName: "sandbox-1",
				rootPath: "/sandbox",
				workingDir: "/sandbox/work/repo",
				provider: "openshell",
				kept: true,
			})),
			runtimeFetch: vi.fn(async () =>
				Response.json({ success: true, port: 3009 }),
			),
		};
		workflowData = {
			getExecutionWorkspaceRoute: vi.fn(async () => ({
				projectId: "project-1",
				userId: "user-1",
				workspaceSlug: "workspace-slug",
			})),
		};
		service = new ApplicationSandboxPreviewService({ preview, workflowData });
	});

	it("starts an execution sandbox preview through the gateway", async () => {
		const request = new Request("http://internal/start", {
			headers: {
				host: "internal.local",
				"x-forwarded-proto": "https",
				"x-forwarded-host": "workflow.example",
			},
		});

		const result = await service.startExecutionSandboxPreview({
			executionId: "exec-1",
			request,
			fallbackUrl: new URL("http://internal/start"),
			body: {
				previewId: " preview-1 ",
				repoPath: " /repo ",
				devServerCommand: " pnpm dev ",
				timeoutSeconds: 90,
			},
		});

		expect(preview.runtimeFetch).toHaveBeenCalledWith(
			"/api/workspaces/preview/start",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					workspaceRef: "workspace-1",
					executionId: "exec-1",
					sandboxName: "sandbox-1",
					rootPath: "/sandbox",
					workingDir: "/sandbox/work/repo",
					provider: "openshell",
					previewId: "preview-1",
					repoPath: "/repo",
					installCommand: undefined,
					devServerCommand: "pnpm dev",
					baseUrl: "http://127.0.0.1:3009",
					timeoutSeconds: 90,
				}),
			}),
		);
		expect(workflowData.getExecutionWorkspaceRoute).toHaveBeenCalledWith("exec-1");
		expect(result).toMatchObject({
			status: "ok",
			body: {
				success: true,
				executionId: "exec-1",
				previewId: "preview-1",
				proxyUrl:
					"https://workflow.example/api/workflows/executions/exec-1/sandbox-preview/preview-1/",
				pageUrl: expect.stringContaining(
					"https://workflow.example/workspaces/workspace-slug/workflows/runtime-preview/exec-1?previewId=preview-1",
				),
				runtime: { success: true, port: 3009 },
			},
		});
	});

	it("returns not found when there is no retained sandbox", async () => {
		vi.mocked(preview.getSandboxPreviewInfo).mockResolvedValueOnce(null);

		const result = await service.startExecutionSandboxPreview({
			executionId: "exec-1",
			request: new Request("http://localhost/start"),
			fallbackUrl: new URL("http://localhost/start"),
			body: {},
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 404,
			body: "Retained sandbox not found for this execution",
		});
		expect(preview.runtimeFetch).not.toHaveBeenCalled();
	});

	it("stops a sandbox preview through the gateway", async () => {
		vi.mocked(preview.runtimeFetch).mockResolvedValueOnce(
			Response.json({ success: true, stopped: true }),
		);

		const result = await service.stopExecutionSandboxPreview({
			executionId: "exec-1",
			previewId: "preview-1",
		});

		expect(preview.runtimeFetch).toHaveBeenCalledWith(
			"/api/workspaces/preview/stop",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ previewId: "preview-1" }),
			}),
		);
		expect(result).toEqual({
			status: "ok",
			body: { success: true, stopped: true },
		});
	});

	it("proxies and rewrites sandbox preview HTML", async () => {
		vi.mocked(preview.runtimeFetch).mockResolvedValueOnce(
			new Response('<html><head></head><body><script src="/app.js"></script></body></html>', {
				status: 200,
				headers: { "content-type": "text/html" },
			}),
		);
		const request = new Request(
			"http://localhost/api/workflows/executions/exec-1/sandbox-preview/preview-1/index.html?x=1",
			{ headers: { accept: "text/html" } },
		);
		const url = new URL(request.url);

		const result = await service.proxyExecutionSandboxPreview({
			executionId: "exec-1",
			previewId: "preview-1",
			path: "index.html",
			request,
			url,
		});

		expect(preview.runtimeFetch).toHaveBeenCalledWith(
			"/api/workspaces/preview/preview-1/index.html?x=1",
			expect.objectContaining({
				method: "GET",
				body: undefined,
			}),
		);
		expect(result.status).toBe("response");
		const response = result.status === "response" ? result.response : null;
		expect(response?.status).toBe(200);
		await expect(response?.text()).resolves.toContain(
			'src="/api/workflows/executions/exec-1/sandbox-preview/preview-1/app.js"',
		);
	});
});

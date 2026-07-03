import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationCliPreviewService } from "$lib/server/application/cli-preview";
import type { CliPreviewGatewayPort } from "$lib/server/application/ports";

describe("ApplicationCliPreviewService", () => {
	let preview: CliPreviewGatewayPort;
	let service: ApplicationCliPreviewService;
	let proxyResponse: Response;

	beforeEach(() => {
		proxyResponse = new Response("proxied", { status: 203 });
		preview = {
			defaultPort: 4321,
			resolveSessionTarget: vi.fn(async () => ({
				ok: true as const,
				target: { podIP: "10.0.0.20", runtime: "codex-cli" },
			})),
			resolveExecutionTarget: vi.fn(async () => ({
				ok: true as const,
				target: {
					podIP: "10.0.0.30",
					appId: "agent-session-preview",
					sharedWorkspaceKey: "exec-key",
					reused: true,
				},
			})),
			startPreview: vi.fn(async () => ({
				ready: true,
				log: "PREVIEW_READY port=5173",
			})),
			proxyPreview: vi.fn(async () => proxyResponse),
			executionPreviewBackend: vi.fn(async () => "cli" as const),
		};
		service = new ApplicationCliPreviewService({ preview });
	});

	it("starts a session preview using gateway resolution and request defaults", async () => {
		const result = await service.startSessionPreview({
			sessionId: "session 1",
			projectId: "project-1",
			origin: "https://workflow-builder.example",
			body: { port: 5173, cwd: "  /repo  ", previewCommand: "pnpm dev" },
		});

		expect(preview.resolveSessionTarget).toHaveBeenCalledWith(
			"session 1",
			"project-1",
		);
		expect(preview.startPreview).toHaveBeenCalledWith("10.0.0.20", {
			port: 5173,
			cwd: "/repo",
			previewCommand: "pnpm dev",
		});
		expect(result).toEqual({
			status: "ok",
			body: {
				ready: true,
				port: 5173,
				cwd: "/repo",
				proxyUrl:
					"https://workflow-builder.example/api/v1/sessions/session%201/cli-preview/view/",
				log: "PREVIEW_READY port=5173",
			},
		});
	});

	it("maps session target resolution failures without starting the preview", async () => {
		vi.mocked(preview.resolveSessionTarget).mockResolvedValueOnce({
			ok: false as const,
			status: 409,
			message: "Session runtime is not an interactive-cli runtime",
		});

		const result = await service.startSessionPreview({
			sessionId: "session-1",
			projectId: "project-1",
			origin: "http://localhost",
			body: {},
		});

		expect(result).toEqual({
			status: "error",
			httpStatus: 409,
			message: "Session runtime is not an interactive-cli runtime",
		});
		expect(preview.startPreview).not.toHaveBeenCalled();
	});

	it("returns execution preview provisioning as an HTTP 202 command result", async () => {
		vi.mocked(preview.resolveExecutionTarget).mockResolvedValueOnce({
			ok: false as const,
			provisioning: true as const,
			status: 202,
			message: "Preview pod is starting - retry shortly.",
		});

		const result = await service.startExecutionPreview({
			executionId: "exec-1",
			projectId: "project-1",
			origin: "http://localhost",
			body: {},
		});

		expect(result).toEqual({
			status: "ok",
			httpStatus: 202,
			body: {
				ready: false,
				provisioning: true,
				message: "Preview pod is starting - retry shortly.",
			},
		});
		expect(preview.startPreview).not.toHaveBeenCalled();
	});

	it("starts an execution preview and preserves reuse metadata", async () => {
		const result = await service.startExecutionPreview({
			executionId: "exec-1",
			projectId: "project-1",
			origin: "https://workflow-builder.example",
			body: {},
		});

		expect(preview.startPreview).toHaveBeenCalledWith("10.0.0.30", {
			port: 4321,
			cwd: "/sandbox/work/repo",
			previewCommand: undefined,
		});
		expect(result).toEqual({
			status: "ok",
			body: {
				ready: true,
				port: 4321,
				cwd: "/sandbox/work/repo",
				reused: true,
				sharedWorkspaceKey: "exec-key",
				proxyUrl:
					"https://workflow-builder.example/api/workflows/executions/exec-1/cli-preview/view/",
				log: "PREVIEW_READY port=5173",
			},
		});
	});

	it("proxies execution preview traffic without provisioning missing preview pods", async () => {
		const request = new Request(
			"http://localhost/api/workflows/executions/exec-1/cli-preview/view/assets/app.js",
		);
		const url = new URL(request.url);
		url.searchParams.set("port", "5173");
		url.searchParams.set("v", "1");

		const result = await service.proxyExecutionPreview({
			executionId: "exec-1",
			projectId: "project-1",
			request,
			url,
			path: "assets/app.js",
		});

		expect(preview.resolveExecutionTarget).toHaveBeenCalledWith(
			"exec-1",
			"project-1",
			{ provisionIfMissing: false },
		);
		expect(preview.proxyPreview).toHaveBeenCalledWith({
			podIP: "10.0.0.30",
			port: 5173,
			request,
			restPath: "/assets/app.js",
			search: "?v=1",
			proxyBasePath:
				"/api/workflows/executions/exec-1/cli-preview/view",
		});
		expect(result).toEqual({ status: "response", response: proxyResponse });
	});

	it("detects the execution preview backend through the gateway", async () => {
		const result = await service.getExecutionPreviewInfo({ executionId: "exec-1" });

		expect(preview.executionPreviewBackend).toHaveBeenCalledWith("exec-1");
		expect(result).toEqual({
			status: "ok",
			body: { backend: "cli" },
		});
	});
});

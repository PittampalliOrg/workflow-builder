import type {
	SandboxPreviewGatewayPort,
	WorkflowDataService,
} from "$lib/server/application/ports";
import { buildRuntimePreviewPath } from "$lib/server/workflows/runtime-preview-url";

type SandboxPreviewErrorResult = {
	status: "error";
	httpStatus: number;
	body: string | { message: string };
};

export type SandboxPreviewCommandResult =
	| {
			status: "ok";
			httpStatus?: number;
			body: Record<string, unknown>;
	  }
	| SandboxPreviewErrorResult;

export type SandboxPreviewProxyResult =
	| { status: "response"; response: Response }
	| SandboxPreviewErrorResult;

type StartSandboxPreviewBody = {
	previewId?: unknown;
	repoPath?: unknown;
	installCommand?: unknown;
	devServerCommand?: unknown;
	baseUrl?: unknown;
	timeoutSeconds?: unknown;
};

const FORWARDED_HEADERS = [
	"accept",
	"accept-language",
	"content-type",
	"user-agent",
	"cache-control",
];

const JAVASCRIPT_CONTENT_TYPES = [
	"text/javascript",
	"application/javascript",
	"application/x-javascript",
];

export class ApplicationSandboxPreviewService {
	constructor(
		private readonly deps: {
			preview: SandboxPreviewGatewayPort;
			workflowData: Pick<WorkflowDataService, "getExecutionWorkspaceRoute">;
		},
	) {}

	async startExecutionSandboxPreview(input: {
		executionId: string;
		request: Request;
		fallbackUrl: URL;
		body: unknown;
	}): Promise<SandboxPreviewCommandResult> {
		const sandbox = await this.deps.preview.getSandboxPreviewInfo(
			input.executionId,
		);
		if (!sandbox) {
			return previewError(404, "Retained sandbox not found for this execution");
		}

		const body = parseStartBody(input.body);
		const previewId = body.previewId || input.executionId;
		const payload = {
			workspaceRef: sandbox.workspaceRef,
			executionId: input.executionId,
			sandboxName: sandbox.sandboxName,
			rootPath: sandbox.rootPath,
			workingDir: sandbox.workingDir,
			provider: sandbox.provider,
			previewId,
			repoPath: body.repoPath || undefined,
			installCommand: body.installCommand || undefined,
			devServerCommand: body.devServerCommand || undefined,
			baseUrl: body.baseUrl || "http://127.0.0.1:3009",
			timeoutSeconds: body.timeoutSeconds ?? 1800,
		};

		const response = await this.deps.preview.runtimeFetch(
			"/api/workspaces/preview/start",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			},
		);
		const result = (await response
			.json()
			.catch(() => ({ error: "Invalid preview response" }))) as Record<
			string,
			unknown
		>;
		if (!response.ok || result.success === false) {
			return previewError(response.ok ? 502 : response.status, {
				message:
					typeof result.error === "string" && result.error
						? result.error
						: "Failed to start sandbox preview",
			});
		}

		const proxyBasePath = `/api/workflows/executions/${encodeURIComponent(input.executionId)}/sandbox-preview/${encodeURIComponent(previewId)}`;
		const pageSearchParams = new URLSearchParams();
		pageSearchParams.set("previewId", previewId);
		if (payload.repoPath) pageSearchParams.set("repoPath", payload.repoPath);
		if (payload.installCommand) {
			pageSearchParams.set("installCommand", payload.installCommand);
		}
		if (payload.devServerCommand) {
			pageSearchParams.set("devServerCommand", payload.devServerCommand);
		}
		if (payload.baseUrl) pageSearchParams.set("baseUrl", payload.baseUrl);
		pageSearchParams.set("timeoutSeconds", String(payload.timeoutSeconds));
		const workspaceRoute = await this.deps.workflowData.getExecutionWorkspaceRoute(
			input.executionId,
		);
		const pageSearch = pageSearchParams.toString();
		const pageBasePath = workspaceRoute
			? buildRuntimePreviewPath(
					input.executionId,
					workspaceRoute.workspaceSlug,
					pageSearch,
				)
			: `/workflows/runtime-preview/${encodeURIComponent(input.executionId)}?${pageSearch}`;
		const origin = publicOrigin(input.request, input.fallbackUrl);

		return {
			status: "ok",
			body: {
				success: true,
				executionId: input.executionId,
				previewId,
				workspaceRef: sandbox.workspaceRef,
				sandboxName: sandbox.sandboxName,
				rootPath: sandbox.rootPath,
				workingDir: sandbox.workingDir,
				provider: sandbox.provider,
				proxyUrl: `${origin}${proxyBasePath}/`,
				pageUrl: `${origin}${pageBasePath}`,
				runtime: result,
			},
		};
	}

	async stopExecutionSandboxPreview(input: {
		executionId: string;
		previewId?: string | null;
	}): Promise<SandboxPreviewCommandResult> {
		const previewId = (input.previewId || input.executionId).trim();
		const response = await this.deps.preview.runtimeFetch(
			"/api/workspaces/preview/stop",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ previewId }),
			},
		);
		const result = (await response
			.json()
			.catch(() => ({ error: "Invalid preview response" }))) as Record<
			string,
			unknown
		>;
		if (!response.ok) {
			return previewError(response.status, {
				message:
					typeof result.error === "string"
						? result.error
						: "Failed to stop sandbox preview",
			});
		}
		return { status: "ok", body: result };
	}

	async proxyExecutionSandboxPreview(input: {
		executionId: string;
		previewId: string;
		path?: string;
		request: Request;
		url: URL;
	}): Promise<SandboxPreviewProxyResult> {
		const sandbox = await this.deps.preview.getSandboxPreviewInfo(
			input.executionId,
		);
		if (!sandbox) {
			return previewError(404, "Retained sandbox not found for this execution");
		}

		const proxyBasePath = `/api/workflows/executions/${encodeURIComponent(input.executionId)}/sandbox-preview/${encodeURIComponent(input.previewId)}`;
		const restPath = input.path ? `/${input.path}` : "/";
		const search = input.url.search || "";
		const targetPath = `/api/workspaces/preview/${encodeURIComponent(input.previewId)}${restPath}${search}`;
		const headers = new Headers();
		for (const header of FORWARDED_HEADERS) {
			const value = input.request.headers.get(header);
			if (value) headers.set(header, value);
		}

		const response = await this.deps.preview.runtimeFetch(targetPath, {
			method: input.request.method,
			headers,
			body:
				input.request.method === "GET" || input.request.method === "HEAD"
					? undefined
					: await input.request.arrayBuffer(),
		});

		const proxiedHeaders = new Headers();
		const contentType = response.headers.get("content-type");
		if (contentType) proxiedHeaders.set("content-type", contentType);
		const cacheControl = response.headers.get("cache-control");
		if (cacheControl) proxiedHeaders.set("cache-control", cacheControl);
		const location = response.headers.get("location");
		if (location) {
			proxiedHeaders.set(
				"location",
				rewriteLocationHeader(location, proxyBasePath),
			);
		}

		if (contentType && contentType.includes("text/html")) {
			const originalBody = await response.text();
			return {
				status: "response",
				response: new Response(rewriteHtmlBody(originalBody, proxyBasePath), {
					status: response.status,
					headers: proxiedHeaders,
				}),
			};
		}

		if (
			contentType &&
			JAVASCRIPT_CONTENT_TYPES.some((type) => contentType.includes(type))
		) {
			const originalBody = await response.text();
			return {
				status: "response",
				response: new Response(
					rewriteJavascriptBody(originalBody, proxyBasePath),
					{
						status: response.status,
						headers: proxiedHeaders,
					},
				),
			};
		}

		if (contentType && contentType.includes("text/css")) {
			const originalBody = await response.text();
			return {
				status: "response",
				response: new Response(rewriteHtmlBody(originalBody, proxyBasePath), {
					status: response.status,
					headers: proxiedHeaders,
				}),
			};
		}

		return {
			status: "response",
			response: new Response(response.body, {
				status: response.status,
				headers: proxiedHeaders,
			}),
		};
	}
}

function parseStartBody(body: unknown) {
	const input = isRecord(body) ? (body as StartSandboxPreviewBody) : {};
	return {
		previewId:
			typeof input.previewId === "string" ? input.previewId.trim() : "",
		repoPath: typeof input.repoPath === "string" ? input.repoPath.trim() : "",
		installCommand:
			typeof input.installCommand === "string"
				? input.installCommand.trim()
				: "",
		devServerCommand:
			typeof input.devServerCommand === "string"
				? input.devServerCommand.trim()
				: "",
		baseUrl: typeof input.baseUrl === "string" ? input.baseUrl.trim() : "",
		timeoutSeconds:
			typeof input.timeoutSeconds === "number" &&
			Number.isFinite(input.timeoutSeconds)
				? input.timeoutSeconds
				: null,
	};
}

function publicOrigin(request: Request, fallback: URL): string {
	const forwardedProto = request.headers
		.get("x-forwarded-proto")
		?.split(",")[0]
		?.trim();
	const forwardedHost = request.headers
		.get("x-forwarded-host")
		?.split(",")[0]
		?.trim();
	const host = forwardedHost || request.headers.get("host") || fallback.host;
	const proto = forwardedProto || fallback.protocol.replace(/:$/, "") || "https";
	return `${proto}://${host}`;
}

function rewriteHtmlBody(body: string, proxyBasePath: string): string {
	const escapedBase = proxyBasePath.replace(/\/$/, "");
	let rewritten = body
		.replace(
			/\b((?:href|src|action|poster|formaction|data-src|data-href)\s*=\s*["'])\/(?!\/)/gi,
			(_, prefix: string) => `${prefix}${escapedBase}/`,
		)
		.replace(
			/(url\((?:['"]?)?)\/(?!\/)/g,
			(_, prefix: string) => `${prefix}${escapedBase}/`,
		);

	const baseHref = `${escapedBase}/`;
	const baseTag = `<base href="${baseHref}">`;
	if (/<base\b/i.test(rewritten)) {
		rewritten = rewritten.replace(/<base\b[^>]*>/i, baseTag);
	} else if (/<head\b[^>]*>/i.test(rewritten)) {
		rewritten = rewritten.replace(
			/<head\b[^>]*>/i,
			(match) => `${match}\n  ${baseTag}`,
		);
	}
	return rewritten;
}

function rewriteJavascriptBody(body: string, proxyBasePath: string): string {
	const escapedBase = proxyBasePath.replace(/\/$/, "");
	return body
		.replace(/\b(import\s*\(\s*["'])\/(?!\/)/g, `$1${escapedBase}/`)
		.replace(/\b(import\s+["'])\/(?!\/)/g, `$1${escapedBase}/`)
		.replace(/\b(from\s+["'])\/(?!\/)/g, `$1${escapedBase}/`);
}

function rewriteLocationHeader(location: string, proxyBasePath: string): string {
	if (
		location.startsWith("http://") ||
		location.startsWith("https://") ||
		location.startsWith(proxyBasePath)
	) {
		return location;
	}
	if (location.startsWith("/")) return `${proxyBasePath}${location}`;
	return `${proxyBasePath}/${location.replace(/^\.?\//, "")}`;
}

function previewError(
	httpStatus: number,
	body: string | { message: string },
): SandboxPreviewErrorResult {
	return { status: "error", httpStatus, body };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

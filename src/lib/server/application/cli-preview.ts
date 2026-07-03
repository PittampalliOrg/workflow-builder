import type { CliPreviewGatewayPort } from "$lib/server/application/ports";

type CliPreviewErrorResult = {
	status: "error";
	httpStatus: number;
	message: string;
};

export type CliPreviewCommandResult =
	| {
			status: "ok";
			httpStatus?: number;
			body: Record<string, unknown>;
	  }
	| CliPreviewErrorResult;

export type CliPreviewProxyResult =
	| { status: "response"; response: Response }
	| CliPreviewErrorResult;

type PreviewBody = {
	port?: unknown;
	cwd?: unknown;
	previewCommand?: unknown;
};

export class ApplicationCliPreviewService {
	constructor(private readonly deps: { preview: CliPreviewGatewayPort }) {}

	async startSessionPreview(input: {
		sessionId: string;
		projectId?: string | null;
		origin: string;
		body: unknown;
	}): Promise<CliPreviewCommandResult> {
		const resolved = await this.deps.preview.resolveSessionTarget(
			input.sessionId,
			input.projectId ?? null,
		);
		if (!resolved.ok) return previewError(resolved.status, resolved.message);

		const request = parsePreviewBody(input.body, this.deps.preview.defaultPort);
		const result = await this.deps.preview.startPreview(resolved.target.podIP, request);
		const base = `/api/v1/sessions/${encodeURIComponent(input.sessionId)}/cli-preview/view/`;
		return {
			status: "ok",
			body: {
				ready: result.ready,
				port: request.port,
				cwd: request.cwd,
				proxyUrl: `${input.origin}${base}`,
				log: result.log,
			},
		};
	}

	async proxySessionPreview(input: {
		sessionId: string;
		projectId?: string | null;
		request: Request;
		url: URL;
		path?: string;
	}): Promise<CliPreviewProxyResult> {
		const resolved = await this.deps.preview.resolveSessionTarget(
			input.sessionId,
			input.projectId ?? null,
		);
		if (!resolved.ok) return previewError(resolved.status, resolved.message);

		const proxy = parseProxyRequest({
			url: input.url,
			path: input.path,
			defaultPort: this.deps.preview.defaultPort,
			proxyBasePath: `/api/v1/sessions/${encodeURIComponent(input.sessionId)}/cli-preview/view`,
		});
		return {
			status: "response",
			response: await this.deps.preview.proxyPreview({
				podIP: resolved.target.podIP,
				port: proxy.port,
				request: input.request,
				restPath: proxy.restPath,
				search: proxy.search,
				proxyBasePath: proxy.proxyBasePath,
			}),
		};
	}

	async startExecutionPreview(input: {
		executionId: string;
		projectId?: string | null;
		origin: string;
		body: unknown;
	}): Promise<CliPreviewCommandResult> {
		const resolved = await this.deps.preview.resolveExecutionTarget(
			input.executionId,
			input.projectId ?? null,
		);
		if (!resolved.ok) {
			if ("provisioning" in resolved && resolved.provisioning) {
				return {
					status: "ok",
					httpStatus: 202,
					body: {
						ready: false,
						provisioning: true,
						message: resolved.message,
					},
				};
			}
			return previewError(resolved.status, resolved.message);
		}

		const request = parsePreviewBody(input.body, this.deps.preview.defaultPort);
		const result = await this.deps.preview.startPreview(resolved.target.podIP, request);
		const base = `/api/workflows/executions/${encodeURIComponent(input.executionId)}/cli-preview/view/`;
		return {
			status: "ok",
			body: {
				ready: result.ready,
				port: request.port,
				cwd: request.cwd,
				reused: resolved.target.reused,
				sharedWorkspaceKey: resolved.target.sharedWorkspaceKey,
				proxyUrl: `${input.origin}${base}`,
				log: result.log,
			},
		};
	}

	async proxyExecutionPreview(input: {
		executionId: string;
		projectId?: string | null;
		request: Request;
		url: URL;
		path?: string;
	}): Promise<CliPreviewProxyResult> {
		const resolved = await this.deps.preview.resolveExecutionTarget(
			input.executionId,
			input.projectId ?? null,
			{ provisionIfMissing: false },
		);
		if (!resolved.ok) {
			return previewError(
				"status" in resolved ? resolved.status : 502,
				"message" in resolved ? resolved.message : "Preview unavailable",
			);
		}

		const proxy = parseProxyRequest({
			url: input.url,
			path: input.path,
			defaultPort: this.deps.preview.defaultPort,
			proxyBasePath: `/api/workflows/executions/${encodeURIComponent(input.executionId)}/cli-preview/view`,
		});
		return {
			status: "response",
			response: await this.deps.preview.proxyPreview({
				podIP: resolved.target.podIP,
				port: proxy.port,
				request: input.request,
				restPath: proxy.restPath,
				search: proxy.search,
				proxyBasePath: proxy.proxyBasePath,
			}),
		};
	}

	async getExecutionPreviewInfo(input: {
		executionId: string;
	}): Promise<CliPreviewCommandResult> {
		return {
			status: "ok",
			body: {
				backend: await this.deps.preview.executionPreviewBackend(input.executionId),
			},
		};
	}
}

function previewError(
	httpStatus: number,
	message: string,
): CliPreviewErrorResult {
	return { status: "error", httpStatus, message };
}

function parsePreviewBody(body: unknown, defaultPort: number) {
	const input = isRecord(body) ? (body as PreviewBody) : {};
	const port =
		typeof input.port === "number" && Number.isFinite(input.port)
			? Math.trunc(input.port)
			: defaultPort;
	const cwd =
		typeof input.cwd === "string" && input.cwd.trim()
			? input.cwd.trim()
			: "/sandbox/work/repo";
	const previewCommand =
		typeof input.previewCommand === "string" ? input.previewCommand : undefined;
	return { port, cwd, previewCommand };
}

function parseProxyRequest(input: {
	url: URL;
	path?: string;
	defaultPort: number;
	proxyBasePath: string;
}) {
	const portParam = Number(input.url.searchParams.get("port"));
	const port =
		Number.isFinite(portParam) && portParam > 0
			? Math.trunc(portParam)
			: input.defaultPort;
	const fwd = new URLSearchParams(input.url.searchParams);
	fwd.delete("port");
	return {
		port,
		proxyBasePath: input.proxyBasePath,
		restPath: input.path ? `/${input.path}` : "/",
		search: fwd.toString() ? `?${fwd.toString()}` : "",
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

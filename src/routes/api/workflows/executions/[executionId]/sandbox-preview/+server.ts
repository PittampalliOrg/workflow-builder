import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getExecutionSandboxPreviewInfo } from '$lib/server/workflows/sandbox-preview';
import {
	buildRuntimePreviewPath,
	getExecutionWorkspaceRoute
} from '$lib/server/workflows/runtime-preview-url';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';

type StartBody = {
	previewId?: string;
	repoPath?: string;
	installCommand?: string;
	devServerCommand?: string;
	baseUrl?: string;
	timeoutSeconds?: number;
};

function publicOrigin(request: Request, fallback: URL): string {
	const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
	const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
	const host = forwardedHost || request.headers.get('host') || fallback.host;
	const proto = forwardedProto || fallback.protocol.replace(/:$/, '') || 'https';
	return `${proto}://${host}`;
}

export const POST: RequestHandler = async ({ params, request, url }) => {
	const { executionId } = params;
	const sandbox = await getExecutionSandboxPreviewInfo(executionId);
	if (!sandbox) {
		throw error(404, 'Retained sandbox not found for this execution');
	}

	const body = (await request.json().catch(() => ({}))) as StartBody;
	const previewId = (body.previewId?.trim() || executionId).trim();
	const payload = {
		workspaceRef: sandbox.workspaceRef,
		executionId,
		sandboxName: sandbox.sandboxName,
		rootPath: sandbox.rootPath,
		workingDir: sandbox.workingDir,
		provider: sandbox.provider,
		previewId,
		repoPath: body.repoPath?.trim() || undefined,
		installCommand: body.installCommand?.trim() || undefined,
		devServerCommand: body.devServerCommand?.trim() || undefined,
		baseUrl: body.baseUrl?.trim() || 'http://127.0.0.1:3009',
		timeoutSeconds:
			typeof body.timeoutSeconds === 'number' && Number.isFinite(body.timeoutSeconds)
				? body.timeoutSeconds
				: 1800
	};

	const response = await openshellRuntimeFetch('/api/workspaces/preview/start', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload)
	});

	const result = (await response.json().catch(() => ({ error: 'Invalid preview response' }))) as Record<
		string,
		unknown
	>;
	if (!response.ok || result.success === false) {
		throw error(response.ok ? 502 : response.status, {
			message:
				typeof result.error === 'string' && result.error
					? result.error
					: 'Failed to start sandbox preview'
		});
	}

	const proxyBasePath = `/api/workflows/executions/${encodeURIComponent(executionId)}/sandbox-preview/${encodeURIComponent(previewId)}`;
	const pageSearchParams = new URLSearchParams();
	pageSearchParams.set('previewId', previewId);
	if (payload.repoPath) pageSearchParams.set('repoPath', payload.repoPath);
	if (payload.installCommand) pageSearchParams.set('installCommand', payload.installCommand);
	if (payload.devServerCommand) pageSearchParams.set('devServerCommand', payload.devServerCommand);
	if (payload.baseUrl) pageSearchParams.set('baseUrl', payload.baseUrl);
	pageSearchParams.set('timeoutSeconds', String(payload.timeoutSeconds));
	const workspaceRoute = await getExecutionWorkspaceRoute(executionId);
	const pageBasePath = workspaceRoute
		? buildRuntimePreviewPath(executionId, workspaceRoute.workspaceSlug, pageSearchParams.toString())
		: `/workflows/runtime-preview/${encodeURIComponent(executionId)}?${pageSearchParams.toString()}`;
	const origin = publicOrigin(request, url);

	return json({
		success: true,
		executionId,
		previewId,
		workspaceRef: sandbox.workspaceRef,
		sandboxName: sandbox.sandboxName,
		rootPath: sandbox.rootPath,
		workingDir: sandbox.workingDir,
		provider: sandbox.provider,
		proxyUrl: `${origin}${proxyBasePath}/`,
		pageUrl: `${origin}${pageBasePath}`,
		runtime: result
	});
};

export const DELETE: RequestHandler = async ({ params, url }) => {
	const { executionId } = params;
	const previewId = (url.searchParams.get('previewId') || executionId).trim();
	const response = await openshellRuntimeFetch('/api/workspaces/preview/stop', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ previewId })
	});
	const result = await response.json().catch(() => ({ error: 'Invalid preview response' }));
	if (!response.ok) {
		throw error(response.status, {
			message:
				typeof (result as Record<string, unknown>).error === 'string'
					? ((result as Record<string, unknown>).error as string)
					: 'Failed to stop sandbox preview'
		});
	}
	return json(result);
};

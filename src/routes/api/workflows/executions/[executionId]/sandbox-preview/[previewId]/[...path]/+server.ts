import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getExecutionSandboxPreviewInfo } from '$lib/server/workflows/sandbox-preview';
import { openshellRuntimeFetch } from '$lib/server/openshell-runtime';

const FORWARDED_HEADERS = [
	'accept',
	'accept-language',
	'content-type',
	'user-agent',
	'cache-control'
];

async function proxyRequest({
	request,
	params,
	url
}: Parameters<RequestHandler>[0]): Promise<Response> {
	const sandbox = await getExecutionSandboxPreviewInfo(params.executionId);
	if (!sandbox) {
		throw error(404, 'Retained sandbox not found for this execution');
	}

	const previewId = params.previewId;
	const restPath = params.path ? `/${params.path}` : '/';
	const search = url.search || '';
	const targetPath = `/api/workspaces/preview/${encodeURIComponent(previewId)}${restPath}${search}`;
	const headers = new Headers();
	for (const header of FORWARDED_HEADERS) {
		const value = request.headers.get(header);
		if (value) headers.set(header, value);
	}

	const response = await openshellRuntimeFetch(targetPath, {
		method: request.method,
		headers,
		body:
			request.method === 'GET' || request.method === 'HEAD'
				? undefined
				: await request.arrayBuffer()
	});

	const proxiedHeaders = new Headers();
	const contentType = response.headers.get('content-type');
	if (contentType) proxiedHeaders.set('content-type', contentType);
	const cacheControl = response.headers.get('cache-control');
	if (cacheControl) proxiedHeaders.set('cache-control', cacheControl);

	return new Response(response.body, {
		status: response.status,
		headers: proxiedHeaders
	});
}

export const GET: RequestHandler = proxyRequest;
export const HEAD: RequestHandler = proxyRequest;
export const POST: RequestHandler = proxyRequest;
export const PUT: RequestHandler = proxyRequest;
export const PATCH: RequestHandler = proxyRequest;
export const DELETE: RequestHandler = proxyRequest;

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

const JAVASCRIPT_CONTENT_TYPES = [
	'text/javascript',
	'application/javascript',
	'application/x-javascript'
];

function rewriteHtmlBody(body: string, proxyBasePath: string): string {
	const escapedBase = proxyBasePath.replace(/\/$/, '');
	let rewritten = body;

	// Rewrite root-relative asset and navigation attributes so the preview stays
	// under the sandbox proxy rather than escaping to the main app origin.
	rewritten = rewritten.replace(
		/\b((?:href|src|action|poster|formaction|data-src|data-href)\s*=\s*["'])\/(?!\/)/gi,
		(_, prefix: string) => `${prefix}${escapedBase}/`
	);
	rewritten = rewritten.replace(
		/(url\((?:['"]?)?)\/(?!\/)/g,
		(_, prefix: string) => `${prefix}${escapedBase}/`
	);

	// SvelteKit normalizes `/previewId/` to `/previewId`, so browser-relative
	// assets such as `styles.css` would otherwise escape the preview id segment.
	const baseHref = `${escapedBase}/`;
	const baseTag = `<base href="${baseHref}">`;
	if (/<base\b/i.test(rewritten)) {
		rewritten = rewritten.replace(/<base\b[^>]*>/i, baseTag);
	} else if (/<head\b[^>]*>/i.test(rewritten)) {
		rewritten = rewritten.replace(/<head\b[^>]*>/i, (match) => `${match}\n  ${baseTag}`);
	}

	return rewritten;
}

function rewriteJavascriptBody(body: string, proxyBasePath: string): string {
	const escapedBase = proxyBasePath.replace(/\/$/, '');
	return body
		.replace(/\b(import\s*\(\s*["'])\/(?!\/)/g, `$1${escapedBase}/`)
		.replace(/\b(import\s+["'])\/(?!\/)/g, `$1${escapedBase}/`)
		.replace(/\b(from\s+["'])\/(?!\/)/g, `$1${escapedBase}/`);
}

function rewriteLocationHeader(location: string, proxyBasePath: string): string {
	if (location.startsWith('http://') || location.startsWith('https://') || location.startsWith(proxyBasePath)) {
		return location;
	}
	if (location.startsWith('/')) {
		return `${proxyBasePath}${location}`;
	}
	return `${proxyBasePath}/${location.replace(/^\.?\//, '')}`;
}

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
	const proxyBasePath = `/api/workflows/executions/${encodeURIComponent(params.executionId)}/sandbox-preview/${encodeURIComponent(previewId)}`;
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
	const location = response.headers.get('location');
	if (location) {
		proxiedHeaders.set('location', rewriteLocationHeader(location, proxyBasePath));
	}

	if (contentType && contentType.includes('text/html')) {
		const originalBody = await response.text();
		const rewrittenBody = rewriteHtmlBody(originalBody, proxyBasePath);
		return new Response(rewrittenBody, {
			status: response.status,
			headers: proxiedHeaders
		});
	}

	if (contentType && JAVASCRIPT_CONTENT_TYPES.some((type) => contentType.includes(type))) {
		const originalBody = await response.text();
		const rewrittenBody = rewriteJavascriptBody(originalBody, proxyBasePath);
		return new Response(rewrittenBody, {
			status: response.status,
			headers: proxiedHeaders
		});
	}

	if (contentType && contentType.includes('text/css')) {
		const originalBody = await response.text();
		const rewrittenBody = rewriteHtmlBody(originalBody, proxyBasePath);
		return new Response(rewrittenBody, {
			status: response.status,
			headers: proxiedHeaders
		});
	}

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

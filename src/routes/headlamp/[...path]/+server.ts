import { error, type RequestHandler } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

import { DEFAULT_HEADLAMP_URL } from "$lib/headlamp/links";
import {
	buildHeadlampProxyRequestHeaders,
	buildHeadlampProxyResponseHeaders,
	buildHeadlampUpstreamRequestUrl,
} from "$lib/server/headlamp-proxy";
import { requirePlatformAdmin } from "$lib/server/platform-admin";

function upstreamBaseUrl(): URL {
	const configured = env.HEADLAMP_EMBEDDED_UPSTREAM_URL?.trim() || DEFAULT_HEADLAMP_URL;
	try {
		return new URL(configured);
	} catch {
		throw error(500, "HEADLAMP_EMBEDDED_UPSTREAM_URL is not a valid URL");
	}
}

const proxy: RequestHandler = async ({ locals, request, url }) => {
	await requirePlatformAdmin(locals);

	const init: RequestInit & { duplex?: "half" } = {
		method: request.method,
		headers: buildHeadlampProxyRequestHeaders({ request, requestUrl: url }),
		redirect: "manual",
	};
	if (request.method !== "GET" && request.method !== "HEAD") {
		init.body = request.body;
		init.duplex = "half";
	}

	const upstreamResponse = await fetch(
		buildHeadlampUpstreamRequestUrl({ requestUrl: url, upstreamBase: upstreamBaseUrl() }),
		init,
	);
	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers: buildHeadlampProxyResponseHeaders(upstreamResponse.headers),
	});
};

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;

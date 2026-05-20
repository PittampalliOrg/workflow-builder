import { error, type RequestHandler } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

import {
	DEFAULT_ARGOCD_EMBED_BASE,
	DEFAULT_ARGOCD_URL,
} from "$lib/embedded-apps/links";
import {
	buildEmbeddedAppProxyRequestHeaders,
	buildEmbeddedAppProxyResponse,
	buildEmbeddedAppUpstreamRequestUrl,
} from "$lib/server/embedded-app-proxy";
import { requirePlatformAdmin } from "$lib/server/platform-admin";

function upstreamBaseUrl(): URL {
	const configured = env.ARGOCD_EMBEDDED_UPSTREAM_URL?.trim() || DEFAULT_ARGOCD_URL;
	try {
		return new URL(configured);
	} catch {
		throw error(500, "ARGOCD_EMBEDDED_UPSTREAM_URL is not a valid URL");
	}
}

function upstreamAuthorization(): string | null {
	const token = env.ARGOCD_EMBEDDED_AUTH_TOKEN?.trim();
	if (!token) return null;
	return token.toLowerCase().startsWith("bearer ") ? token : `Bearer ${token}`;
}

const proxy: RequestHandler = async ({ locals, request, url }) => {
	await requirePlatformAdmin(locals);
	const upstreamBase = upstreamBaseUrl();

	const init: RequestInit & { duplex?: "half" } = {
		method: request.method,
		headers: buildEmbeddedAppProxyRequestHeaders({
			request,
			requestUrl: url,
			upstreamAuthorization: upstreamAuthorization(),
		}),
		redirect: "manual",
	};
	if (request.method !== "GET" && request.method !== "HEAD") {
		init.body = request.body;
		init.duplex = "half";
	}

	const upstreamResponse = await fetch(
		buildEmbeddedAppUpstreamRequestUrl({
			requestUrl: url,
			upstreamBase,
			embedBase: DEFAULT_ARGOCD_EMBED_BASE,
		}),
		init,
	);
	return buildEmbeddedAppProxyResponse({
		upstreamResponse,
		upstreamBase,
		requestUrl: url,
		embedBase: DEFAULT_ARGOCD_EMBED_BASE,
		rewriteHtmlBase: true,
	});
};

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;

import { error, type RequestHandler } from "@sveltejs/kit";
import { env } from "$env/dynamic/private";

import {
	DEFAULT_MLFLOW_EMBED_BASE,
	DEFAULT_MLFLOW_URL,
} from "$lib/embedded-apps/links";
import {
	buildEmbeddedAppProxyRequestHeaders,
	buildEmbeddedAppProxyResponse,
	buildEmbeddedAppUpstreamRequestUrl,
} from "$lib/server/embedded-app-proxy";
import { requirePlatformAdmin } from "$lib/server/platform-admin";

function upstreamBaseUrl(): URL {
	const configured =
		env.MLFLOW_EMBEDDED_UPSTREAM_URL?.trim() ||
		env.MLFLOW_TRACKING_URI?.trim() ||
		DEFAULT_MLFLOW_URL;
	try {
		return new URL(configured);
	} catch {
		throw error(500, "MLFLOW_EMBEDDED_UPSTREAM_URL is not a valid URL");
	}
}

const proxy: RequestHandler = async ({ locals, request, url }) => {
	await requirePlatformAdmin(locals);
	const upstreamBase = upstreamBaseUrl();

	const init: RequestInit & { duplex?: "half" } = {
		method: request.method,
		headers: buildEmbeddedAppProxyRequestHeaders({ request, requestUrl: url }),
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
			embedBase: DEFAULT_MLFLOW_EMBED_BASE,
		}),
		init,
	);
	return buildEmbeddedAppProxyResponse({
		upstreamResponse,
		upstreamBase,
		requestUrl: url,
		embedBase: DEFAULT_MLFLOW_EMBED_BASE,
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

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

function stripEmbedBase(pathname: string, embedBase: string): string {
	const base = embedBase.replace(/\/+$/, "") || "/";
	if (base === "/") return pathname || "/";
	if (pathname === base) return "/";
	if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length) || "/";
	return pathname || "/";
}

function joinPaths(basePath: string, requestPath: string): string {
	const normalizedBase = basePath.replace(/\/+$/, "");
	const normalizedRequest = requestPath.startsWith("/") ? requestPath : `/${requestPath}`;
	return `${normalizedBase}${normalizedRequest}`.replace(/\/{2,}/g, "/") || "/";
}

export function buildEmbeddedAppUpstreamRequestUrl(input: {
	requestUrl: URL;
	upstreamBase: URL;
	embedBase: string;
}): string {
	const upstream = new URL(input.upstreamBase);
	const requestPath = stripEmbedBase(input.requestUrl.pathname, input.embedBase);
	upstream.pathname = joinPaths(upstream.pathname, requestPath);
	upstream.search = input.requestUrl.search;
	return upstream.toString();
}

export function buildEmbeddedAppProxyRequestHeaders(input: {
	request: Request;
	requestUrl: URL;
	upstreamAuthorization?: string | null;
}): Headers {
	const headers = new Headers(input.request.headers);
	for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
	headers.delete("accept-encoding");
	headers.delete("authorization");
	headers.delete("cookie");
	headers.set("x-forwarded-host", input.requestUrl.host);
	headers.set("x-forwarded-proto", input.requestUrl.protocol.replace(":", ""));
	const upstreamAuthorization = input.upstreamAuthorization?.trim();
	if (upstreamAuthorization) headers.set("authorization", upstreamAuthorization);
	return headers;
}

function rewriteLocation(input: {
	location: string;
	upstreamBase: URL;
	requestUrl: URL;
	embedBase: string;
}): string {
	try {
		const upstreamOrigin = input.upstreamBase.origin;
		const upstreamBasePath = input.upstreamBase.pathname.replace(/\/+$/, "");
		const locationUrl = new URL(input.location, input.upstreamBase);
		if (locationUrl.origin !== upstreamOrigin) return input.location;

		let path = locationUrl.pathname;
		if (upstreamBasePath && path.startsWith(`${upstreamBasePath}/`)) {
			path = path.slice(upstreamBasePath.length) || "/";
		} else if (upstreamBasePath && path === upstreamBasePath) {
			path = "/";
		}
		const embedPath = joinPaths(input.embedBase, path);
		return `${input.requestUrl.origin}${embedPath}${locationUrl.search}${locationUrl.hash}`;
	} catch {
		return input.location;
	}
}

export function buildEmbeddedAppProxyResponseHeaders(input: {
	upstreamHeaders: Headers;
	upstreamBase: URL;
	requestUrl: URL;
	embedBase: string;
}): Headers {
	const headers = new Headers(input.upstreamHeaders);
	headers.delete("content-length");
	headers.delete("content-encoding");
	headers.delete("x-frame-options");
	headers.delete("content-security-policy");
	headers.delete("content-security-policy-report-only");
	const location = headers.get("location");
	if (location) {
		headers.set("location", rewriteLocation({ location, ...input }));
	}
	return headers;
}

function rewriteBaseHref(html: string, embedBase: string): string {
	const href = `${embedBase.replace(/\/+$/, "") || "/"}/`;
	if (/<base\s+href=/i.test(html)) {
		return html.replace(/<base\s+href=(["'])[^"']*\1\s*\/?>/i, `<base href="${href}">`);
	}
	return html.replace(/<head([^>]*)>/i, `<head$1><base href="${href}">`);
}

export async function buildEmbeddedAppProxyResponse(input: {
	upstreamResponse: Response;
	upstreamBase: URL;
	requestUrl: URL;
	embedBase: string;
	rewriteHtmlBase?: boolean;
}): Promise<Response> {
	const headers = buildEmbeddedAppProxyResponseHeaders({
		upstreamHeaders: input.upstreamResponse.headers,
		upstreamBase: input.upstreamBase,
		requestUrl: input.requestUrl,
		embedBase: input.embedBase,
	});

	const contentType = input.upstreamResponse.headers.get("content-type") ?? "";
	if (input.rewriteHtmlBase && contentType.toLowerCase().includes("text/html")) {
		const html = rewriteBaseHref(await input.upstreamResponse.text(), input.embedBase);
		headers.set("content-type", contentType);
		headers.set("content-length", new TextEncoder().encode(html).length.toString());
		return new Response(html, {
			status: input.upstreamResponse.status,
			statusText: input.upstreamResponse.statusText,
			headers,
		});
	}

	return new Response(input.upstreamResponse.body, {
		status: input.upstreamResponse.status,
		statusText: input.upstreamResponse.statusText,
		headers,
	});
}

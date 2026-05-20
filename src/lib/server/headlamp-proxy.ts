import { DEFAULT_HEADLAMP_EMBED_BASE } from "$lib/headlamp/links";

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

export function buildHeadlampUpstreamRequestUrl(input: {
	requestUrl: URL;
	upstreamBase: URL;
	embedBase?: string;
}): string {
	const upstream = new URL(input.upstreamBase);
	const embedBase = (input.embedBase ?? DEFAULT_HEADLAMP_EMBED_BASE).replace(/\/+$/, "");
	const requestPath =
		input.requestUrl.pathname === embedBase ? `${embedBase}/` : input.requestUrl.pathname;
	const upstreamPath = upstream.pathname.replace(/\/+$/, "");
	const requestPathForBase = upstreamPath.endsWith(embedBase)
		? requestPath.replace(new RegExp(`^${embedBase}(?=/|$)`), "") || "/"
		: requestPath;
	upstream.pathname = `${upstreamPath}${requestPathForBase}`.replace(/\/{2,}/g, "/");
	upstream.search = input.requestUrl.search;
	return upstream.toString();
}

export function buildHeadlampProxyRequestHeaders(input: {
	request: Request;
	requestUrl: URL;
}): Headers {
	const headers = new Headers(input.request.headers);
	for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
	headers.delete("accept-encoding");
	headers.set("x-forwarded-host", input.requestUrl.host);
	headers.set("x-forwarded-proto", input.requestUrl.protocol.replace(":", ""));
	return headers;
}

export function buildHeadlampProxyResponseHeaders(upstreamHeaders: Headers): Headers {
	const headers = new Headers(upstreamHeaders);
	headers.delete("content-length");
	headers.delete("content-encoding");
	headers.delete("x-frame-options");
	headers.delete("content-security-policy");
	headers.delete("content-security-policy-report-only");
	return headers;
}

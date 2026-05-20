import { describe, expect, it } from "vitest";

import {
	buildHeadlampProxyRequestHeaders,
	buildHeadlampProxyResponseHeaders,
	buildHeadlampUpstreamRequestUrl,
} from "./headlamp-proxy";

describe("Headlamp proxy helpers", () => {
	it("preserves same-origin /headlamp paths for an upstream that serves that base path", () => {
		expect(
			buildHeadlampUpstreamRequestUrl({
				requestUrl: new URL("https://workflow-builder.local/headlamp/c/ryzen/pods?x=1"),
				upstreamBase: new URL("https://headlamp-hub.tail286401.ts.net/headlamp"),
			}),
		).toBe("https://headlamp-hub.tail286401.ts.net/headlamp/c/ryzen/pods?x=1");
	});

	it("adds the trailing slash required by Headlamp's embedded base route", () => {
		expect(
			buildHeadlampUpstreamRequestUrl({
				requestUrl: new URL("https://workflow-builder.local/headlamp"),
				upstreamBase: new URL("http://headlamp-hub-egress.tailscale.svc.cluster.local/"),
			}),
		).toBe("http://headlamp-hub-egress.tailscale.svc.cluster.local/headlamp/");
		expect(
			buildHeadlampUpstreamRequestUrl({
				requestUrl: new URL("https://workflow-builder.local/headlamp"),
				upstreamBase: new URL("http://headlamp-hub-egress.tailscale.svc.cluster.local/headlamp"),
			}),
		).toBe("http://headlamp-hub-egress.tailscale.svc.cluster.local/headlamp/");
	});

	it("forwards /headlamp paths to root-based upstreams without duplicating slashes", () => {
		expect(
			buildHeadlampUpstreamRequestUrl({
				requestUrl: new URL("https://workflow-builder.local/headlamp/c/dev/"),
				upstreamBase: new URL("https://headlamp-hub.tail286401.ts.net/"),
			}),
		).toBe("https://headlamp-hub.tail286401.ts.net/headlamp/c/dev/");
	});

	it("filters hop-by-hop request headers and iframe-blocking response headers", () => {
		const requestHeaders = buildHeadlampProxyRequestHeaders({
			request: new Request("https://workflow-builder.local/headlamp/", {
				headers: {
					"accept-encoding": "gzip",
					connection: "keep-alive",
					cookie: "wb_access_token=token",
					host: "workflow-builder.local",
				},
			}),
			requestUrl: new URL("https://workflow-builder.local/headlamp/"),
		});
		expect(requestHeaders.get("accept-encoding")).toBeNull();
		expect(requestHeaders.get("connection")).toBeNull();
		expect(requestHeaders.get("host")).toBeNull();
		expect(requestHeaders.get("cookie")).toBe("wb_access_token=token");
		expect(requestHeaders.get("x-forwarded-host")).toBe("workflow-builder.local");
		expect(requestHeaders.get("x-forwarded-proto")).toBe("https");

		const responseHeaders = buildHeadlampProxyResponseHeaders(
			new Headers({
				"content-security-policy": "frame-ancestors 'none'",
				"content-encoding": "gzip",
				"content-length": "10",
				"x-frame-options": "DENY",
				"content-type": "text/html",
			}),
		);
		expect(responseHeaders.get("content-security-policy")).toBeNull();
		expect(responseHeaders.get("content-encoding")).toBeNull();
		expect(responseHeaders.get("content-length")).toBeNull();
		expect(responseHeaders.get("x-frame-options")).toBeNull();
		expect(responseHeaders.get("content-type")).toBe("text/html");
	});
});

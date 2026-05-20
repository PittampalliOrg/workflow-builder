import { describe, expect, it } from "vitest";

import {
	buildEmbeddedAppProxyRequestHeaders,
	buildEmbeddedAppProxyResponseHeaders,
	buildEmbeddedAppUpstreamRequestUrl,
} from "./embedded-app-proxy";

describe("buildEmbeddedAppUpstreamRequestUrl", () => {
	it("strips the same-origin embed base for root-served upstream apps", () => {
		expect(
			buildEmbeddedAppUpstreamRequestUrl({
				requestUrl: new URL("https://workflow-builder.local/argocd/applications?search=dev"),
				upstreamBase: new URL("https://argocd-hub.tail286401.ts.net/"),
				embedBase: "/argocd",
			}),
		).toBe("https://argocd-hub.tail286401.ts.net/applications?search=dev");
	});

	it("preserves an upstream base path when one is configured", () => {
		expect(
			buildEmbeddedAppUpstreamRequestUrl({
				requestUrl: new URL("https://workflow-builder.local/mlflow/static-files/main.js"),
				upstreamBase: new URL("https://hub.example/observe"),
				embedBase: "/mlflow",
			}),
		).toBe("https://hub.example/observe/static-files/main.js");
	});
});

describe("buildEmbeddedAppProxyRequestHeaders", () => {
	it("does not forward Workflow Builder credentials to embedded app upstreams", () => {
		const headers = buildEmbeddedAppProxyRequestHeaders({
			request: new Request("https://workflow-builder.local/argocd/applications", {
				headers: {
					authorization: "Bearer workflow-builder-token",
					cookie: "wb_access_token=token",
				},
			}),
			requestUrl: new URL("https://workflow-builder.local/argocd/applications"),
		});

		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("cookie")).toBeNull();
	});

	it("injects configured upstream authorization", () => {
		const headers = buildEmbeddedAppProxyRequestHeaders({
			request: new Request("https://workflow-builder.local/argocd/applications"),
			requestUrl: new URL("https://workflow-builder.local/argocd/applications"),
			upstreamAuthorization: "Bearer argocd-token",
		});

		expect(headers.get("authorization")).toBe("Bearer argocd-token");
	});
});

describe("buildEmbeddedAppProxyResponseHeaders", () => {
	it("removes frame-blocking headers and rewrites upstream redirects", () => {
		const headers = buildEmbeddedAppProxyResponseHeaders({
			upstreamHeaders: new Headers({
				location: "https://argocd-hub.tail286401.ts.net/auth/login",
				"x-frame-options": "sameorigin",
				"content-security-policy": "frame-ancestors 'self'",
			}),
			upstreamBase: new URL("https://argocd-hub.tail286401.ts.net/"),
			requestUrl: new URL("https://workflow-builder.local/argocd/applications"),
			embedBase: "/argocd",
		});

		expect(headers.get("x-frame-options")).toBeNull();
		expect(headers.get("content-security-policy")).toBeNull();
		expect(headers.get("location")).toBe("https://workflow-builder.local/argocd/auth/login");
	});
});

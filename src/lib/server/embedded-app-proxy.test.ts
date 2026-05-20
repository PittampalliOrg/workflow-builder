import { describe, expect, it } from "vitest";

import {
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

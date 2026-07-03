import { describe, expect, it } from "vitest";

import {
	DEFAULT_ARGOCD_EMBED_BASE,
	argocdEmbedSrc,
	argocdExternalUrl,
	normalizeEmbeddedAppPath,
	withEmbeddedAppChrome,
} from "./links";

describe("normalizeEmbeddedAppPath", () => {
	it("keeps path, query, and hash while stripping embed chrome params", () => {
		expect(
			normalizeEmbeddedAppPath({
				value: "/argocd/#/applications?x=1",
				embedBase: DEFAULT_ARGOCD_EMBED_BASE,
			}),
		).toBe("/#/applications?x=1");
		expect(
			normalizeEmbeddedAppPath({
				value: "/argocd/applications?search=workflow-builder&wb_chrome=unified",
				embedBase: DEFAULT_ARGOCD_EMBED_BASE,
			}),
		).toBe("/applications?search=workflow-builder");
	});

	it("accepts absolute upstream URLs", () => {
		expect(
			normalizeEmbeddedAppPath({
				value: "https://argocd-hub.tail286401.ts.net/applications/argocd/dev-workflow-builder",
				embedBase: DEFAULT_ARGOCD_EMBED_BASE,
			}),
		).toBe("/applications/argocd/dev-workflow-builder");
	});

	it("rejects unsafe or relative values", () => {
		expect(normalizeEmbeddedAppPath({ value: "applications", embedBase: "/argocd" })).toBe("/");
		expect(normalizeEmbeddedAppPath({ value: "//example.test/x", embedBase: "/argocd" })).toBe(
			"/",
		);
		expect(normalizeEmbeddedAppPath({ value: "/a\\b", embedBase: "/argocd" })).toBe("/");
	});
});

describe("embedded app links", () => {
	it("builds same-origin Argo CD iframe sources", () => {
		expect(argocdEmbedSrc({ path: "/applications?search=workflow-builder" })).toBe(
			"/argocd/applications?search=workflow-builder",
		);
	});

	it("builds external links without workflow-builder chrome params", () => {
		expect(
			argocdExternalUrl({
				argocdBase: "https://argocd.example/",
				path: "/argocd/applications?search=dev",
			}),
		).toBe("https://argocd.example/applications?search=dev");
	});

	it("preserves hash when adding chrome mode", () => {
		expect(withEmbeddedAppChrome({ src: "/argocd/#/applications", chrome: "unified" })).toBe(
			"/argocd/?wb_chrome=unified#/applications",
		);
	});
});

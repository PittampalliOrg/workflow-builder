import { describe, expect, it } from "vitest";
import {
	fileScopeLabel,
	parseFileScope,
	resolveFileScopeLink,
} from "./file-scope";

describe("parseFileScope", () => {
	it("parses a preview-archive scope", () => {
		expect(parseFileScope("preview-archive:pr-42")).toEqual({
			kind: "preview-archive",
			name: "pr-42",
		});
	});

	it("treats any other scope as a session id", () => {
		expect(parseFileScope("sess-abc")).toEqual({
			kind: "session",
			sessionId: "sess-abc",
		});
	});
});

describe("resolveFileScopeLink", () => {
	it("routes preview-archive scopes to the archived-previews browser", () => {
		expect(resolveFileScopeLink("acme", "preview-archive:pr-42")).toBe(
			"/workspaces/acme/previews/archived/pr-42",
		);
	});

	it("url-encodes the preview name", () => {
		expect(resolveFileScopeLink("acme", "preview-archive:gan/feature x")).toBe(
			"/workspaces/acme/previews/archived/gan%2Ffeature%20x",
		);
	});

	it("routes session scopes to the session detail page", () => {
		expect(resolveFileScopeLink("acme", "sess-abc")).toBe(
			"/workspaces/acme/sessions/sess-abc",
		);
	});

	it("returns null for an empty scope", () => {
		expect(resolveFileScopeLink("acme", null)).toBeNull();
		expect(resolveFileScopeLink("acme", "")).toBeNull();
	});
});

describe("fileScopeLabel", () => {
	it("labels a preview archive without leaking the prefix", () => {
		expect(fileScopeLabel("preview-archive:pr-42")).toBe("preview pr-42");
	});

	it("truncates a session id", () => {
		expect(fileScopeLabel("0123456789abcdef")).toBe("0123456789ab");
	});
});

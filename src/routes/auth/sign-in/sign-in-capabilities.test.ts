import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	socialAuthReadModel: vi.fn(() => ({
		providers: [
			{ provider: "github", available: false, code: "not_configured" },
			{ provider: "google", available: true, code: "available" },
		],
	})),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		deploymentCapabilities: {
			socialAuthReadModel: mocks.socialAuthReadModel,
		},
	}),
}));

import { load } from "./+page.server";

describe("sign-in deployment capabilities", () => {
	it("loads social-auth availability from the application boundary", async () => {
		expect(await load({} as never)).toEqual({
			socialAuth: {
				providers: [
					{ provider: "github", available: false, code: "not_configured" },
					{ provider: "google", available: true, code: "available" },
				],
			},
		});
	});

	it("renders provider buttons only from server-derived availability", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+page.svelte"),
			"utf8",
		);
		expect(source).toContain("data.socialAuth.providers.some");
		expect(source).toContain("{#if githubAvailable}");
		expect(source).toContain("{#if googleAvailable}");
		expect(source).not.toContain("GITHUB_CLIENT_ID");
		expect(source).not.toContain("GOOGLE_CLIENT_ID");
	});
});

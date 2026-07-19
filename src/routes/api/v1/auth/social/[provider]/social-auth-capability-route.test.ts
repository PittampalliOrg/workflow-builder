import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	availability: vi.fn(),
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		deploymentCapabilities: {
			socialAuthAvailability: mocks.availability,
		},
	}),
}));

import { GET as startSocialAuth } from "./+server";
import { GET as completeSocialAuth } from "./callback/+server";

describe("social-auth deployment capability routes", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.availability.mockReturnValue({
			available: false,
			code: "not_configured",
			message: "github social auth is not configured for this deployment",
		});
	});

	it("returns stable not-configured JSON before creating OAuth state", async () => {
		const cookies = { set: vi.fn() };
		const response = (await startSocialAuth({
			params: { provider: "github" },
			url: new URL("https://preview.test/api/v1/auth/social/github"),
			request: new Request("https://preview.test/api/v1/auth/social/github"),
			cookies,
		} as never)) as Response;

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toEqual({
			error: "not_configured",
			provider: "github",
			message: "github social auth is not configured for this deployment",
		});
		expect(cookies.set).not.toHaveBeenCalled();
	});

	it("returns the same stable preflight from the callback route", async () => {
		const response = (await completeSocialAuth({
			params: { provider: "github" },
			url: new URL(
				"https://preview.test/api/v1/auth/social/github/callback?code=code&state=state",
			),
			request: new Request(
				"https://preview.test/api/v1/auth/social/github/callback?code=code&state=state",
			),
			cookies: { get: vi.fn(() => "state"), delete: vi.fn(), set: vi.fn() },
		} as never)) as Response;

		expect(response.status).toBe(503);
		await expect(response.json()).resolves.toMatchObject({
			error: "not_configured",
			provider: "github",
		});
	});

	it("distinguishes unsupported providers from missing configuration", async () => {
		mocks.availability.mockReturnValue({
			available: false,
			code: "unsupported",
			message: "Social auth provider 'oidc' is unsupported",
		});
		const response = (await startSocialAuth({
			params: { provider: "oidc" },
			url: new URL("https://preview.test/api/v1/auth/social/oidc"),
			request: new Request("https://preview.test/api/v1/auth/social/oidc"),
			cookies: { set: vi.fn() },
		} as never)) as Response;

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: "unsupported",
			provider: "oidc",
		});
	});
});

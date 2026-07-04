import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	signInWithPassword: vi.fn(),
	shouldUseSecureCookies: vi.fn(),
}));

vi.mock("$lib/server/auth-cookies", () => ({
	ACCESS_TOKEN_COOKIE: "wb_access_token",
	REFRESH_TOKEN_COOKIE: "wb_refresh_token",
	shouldUseSecureCookies: mocks.shouldUseSecureCookies,
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		authSignIn: {
			signInWithPassword: mocks.signInWithPassword,
		},
	}),
}));

import { POST } from "./+server";

describe("password sign-in route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.shouldUseSecureCookies.mockReturnValue(true);
		mocks.signInWithPassword.mockResolvedValue({
			ok: true,
			accessToken: "access-token",
			refreshToken: "refresh-token",
			user: {
				id: "user-1",
				email: "ada@example.com",
				name: "Ada",
				image: null,
			},
		});
	});

	it("sets auth cookies from the password sign-in use case", async () => {
		const cookies = {
			set: vi.fn(),
		};
		const body = {
			email: "ada@example.com",
			password: "correct horse battery staple",
		};

		const response = (await POST({
			request: new Request("https://workflow-builder.test", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			cookies,
		} as never)) as Response;
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.signInWithPassword).toHaveBeenCalledWith(body);
		expect(mocks.shouldUseSecureCookies).toHaveBeenCalledTimes(1);
		expect(cookies.set).toHaveBeenCalledWith(
			"wb_access_token",
			"access-token",
			expect.objectContaining({
				path: "/",
				httpOnly: true,
				secure: true,
				sameSite: "lax",
			}),
		);
		expect(cookies.set).toHaveBeenCalledWith(
			"wb_refresh_token",
			"refresh-token",
			expect.objectContaining({
				path: "/",
				httpOnly: true,
				secure: true,
				sameSite: "lax",
			}),
		);
		expect(payload).toEqual({
			user: {
				id: "user-1",
				email: "ada@example.com",
				name: "Ada",
				image: null,
			},
			accessToken: "access-token",
		});
	});

	it("maps failed sign-in results to the service status and message", async () => {
		mocks.signInWithPassword.mockResolvedValue({
			ok: false,
			status: 400,
			message: "Invalid email or password",
		});

		const response = (await POST({
			request: new Request("http://localhost", {
				method: "POST",
				body: JSON.stringify({ email: "ada@example.com", password: "bad" }),
			}),
			cookies: { set: vi.fn() },
		} as never)) as Response;
		const payload = await response.json();

		expect(response.status).toBe(400);
		expect(payload).toEqual({ message: "Invalid email or password" });
	});

	it("keeps the route free of direct DB imports", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters().authSignIn.signInWithPassword");
		expect(source).not.toContain("$lib/server/auth/password-sign-in");
		expect(source).not.toContain("$lib/server/auth-social");
		expect(source).not.toContain("$lib/server/auth\"");
		expect(source).not.toContain("$lib/server/auth'");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("userIdentities");
		expect(source).not.toContain("platforms");
		expect(source).not.toContain("projects");
	});
});

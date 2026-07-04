import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACCESS_TOKEN_COOKIE,
	REFRESH_TOKEN_COOKIE,
} from "$lib/server/auth-cookies";

const mocks = vi.hoisted(() => {
	const authSession = {
		refreshTokens: vi.fn(async () => ({
			accessToken: "access-2",
			refreshToken: "refresh-2",
		})),
	};
	return { authSession };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ authSession: mocks.authSession }),
}));

import { POST } from "./+server";

describe("/api/v1/auth/refresh route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.authSession.refreshTokens.mockResolvedValue({
			accessToken: "access-2",
			refreshToken: "refresh-2",
		});
	});

	it("keeps refresh token validation behind the auth-session application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("authSession.refreshTokens");
		expect(source).not.toMatch(/from ['"]\$lib\/server\/auth['"]/);
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("sets refreshed cookies and returns the new access token", async () => {
		const request = new Request("http://localhost/api/v1/auth/refresh", {
			method: "POST",
		});
		const cookies = {
			get: vi.fn((name: string) =>
				name === REFRESH_TOKEN_COOKIE ? "refresh-1" : undefined,
			),
			set: vi.fn(),
			delete: vi.fn(),
		};
		const response = (await POST({ request, cookies } as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ accessToken: "access-2" });
		expect(mocks.authSession.refreshTokens).toHaveBeenCalledWith({
			refreshToken: "refresh-1",
		});
		expect(cookies.set).toHaveBeenCalledWith(
			ACCESS_TOKEN_COOKIE,
			"access-2",
			expect.objectContaining({ httpOnly: true, path: "/" }),
		);
		expect(cookies.set).toHaveBeenCalledWith(
			REFRESH_TOKEN_COOKIE,
			"refresh-2",
			expect.objectContaining({ httpOnly: true, path: "/" }),
		);
	});
});

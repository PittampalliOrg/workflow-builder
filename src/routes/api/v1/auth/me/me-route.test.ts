import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const authSession = {
		getSession: vi.fn(async () => ({
			user: {
				id: "user-1",
				email: "user@example.com",
				name: "User",
				image: null,
				platformId: "platform-1",
				projectId: "project-1",
			},
		})),
	};
	return { authSession };
});

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({ authSession: mocks.authSession }),
}));

import { GET } from "./+server";

describe("/api/v1/auth/me route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps session lookup behind the auth-session application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("authSession.getSession");
		expect(source).not.toMatch(/from ['"]\$lib\/server\/auth['"]/);
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("returns the authenticated user", async () => {
		const request = new Request("http://localhost/api/v1/auth/me");
		const cookies = {};
		const response = (await GET({ request, cookies } as never)) as Response;

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			user: {
				id: "user-1",
				email: "user@example.com",
				name: "User",
				image: null,
				platformId: "platform-1",
				projectId: "project-1",
			},
		});
		expect(mocks.authSession.getSession).toHaveBeenCalledWith({
			request,
			cookies,
		});
	});
});

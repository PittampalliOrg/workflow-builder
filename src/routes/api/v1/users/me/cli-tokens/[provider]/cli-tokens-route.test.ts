import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	cliCredentials: {
		getCredentialSummary: vi.fn(async () => ({
			provider: "openai",
			linked: true,
			expiresAt: "2026-01-01T00:00:00.000Z",
			lastValidatedAt: null,
			status: "active",
		})),
		upsertUserCredential: vi.fn(async () => ({
			provider: "openai",
			linked: true,
			expiresAt: "2026-01-01T00:00:00.000Z",
			lastValidatedAt: null,
			status: "active",
		})),
		deleteUserCredential: vi.fn(async () => true),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		cliCredentials: mocks.cliCredentials,
	}),
}));

import { DELETE, GET, PUT } from "./+server";

function event(body?: unknown) {
	return {
		params: { provider: "openai" },
		locals: {
			session: {
				userId: "user-1",
				projectId: "project-1",
			},
		},
		request: new Request(
			"http://localhost/api/v1/users/me/cli-tokens/openai",
			body === undefined
				? undefined
				: {
						method: "PUT",
						body: JSON.stringify(body),
						headers: { "Content-Type": "application/json" },
					},
		),
	};
}

describe("CLI token API route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("delegates reads to the CLI credential application service", async () => {
		const response = (await GET(event() as never)) as Response;

		await expect(response.json()).resolves.toMatchObject({
			provider: "openai",
			linked: true,
			status: "active",
		});
		expect(mocks.cliCredentials.getCredentialSummary).toHaveBeenCalledWith(
			"user-1",
			"openai",
		);
	});

	it("delegates upserts with parsed expiry to the CLI credential application service", async () => {
		const response = (await PUT(
			event({
				token: "token-value",
				expiresAt: "2026-01-01T00:00:00.000Z",
			}) as never,
		)) as Response;

		expect(response.status).toBe(200);
		expect(mocks.cliCredentials.upsertUserCredential).toHaveBeenCalledWith(
			"user-1",
			"openai",
			"token-value",
			new Date("2026-01-01T00:00:00.000Z"),
		);
	});

	it("delegates deletes to the CLI credential application service", async () => {
		const response = (await DELETE(event() as never)) as Response;

		await expect(response.json()).resolves.toEqual({ ok: true, deleted: true });
		expect(mocks.cliCredentials.deleteUserCredential).toHaveBeenCalledWith(
			"user-1",
			"openai",
		);
	});

	it("keeps persistence details out of the route", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("cliCredentials.getCredentialSummary");
		expect(source).toContain("cliCredentials.upsertUserCredential");
		expect(source).toContain("cliCredentials.deleteUserCredential");
		expect(source).not.toContain("$lib/server/users/cli-credentials");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	vaults: {
		list: vi.fn(async () => ({ vaults: [{ id: "vault-1" }] })),
		create: vi.fn(async () => ({ vault: { id: "vault-2" } })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		vaults: mocks.vaults,
	}),
}));

import { GET, POST } from "./+server";

describe("/api/v1/vaults route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps vault metadata behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("vaults.list");
		expect(source).toContain("vaults.create");
		expect(source).not.toContain("$lib/server/vaults/registry");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates list and create requests", async () => {
		const url = new URL("http://localhost/api/v1/vaults?q=github");
		const getResponse = await GET({
			url,
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(getResponse.status).toBe(200);
		await expect(getResponse.json()).resolves.toEqual({
			vaults: [{ id: "vault-1" }],
		});

		const body = { name: "GitHub" };
		const postResponse = await POST({
			request: new Request("http://localhost/api/v1/vaults", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(postResponse.status).toBe(201);
		await expect(postResponse.json()).resolves.toEqual({
			vault: { id: "vault-2" },
		});
		expect(mocks.vaults.list).toHaveBeenCalledWith({
			query: url.searchParams,
			sessionProjectId: "project-1",
		});
		expect(mocks.vaults.create).toHaveBeenCalledWith({
			userId: "user-1",
			body,
		});
	});
});

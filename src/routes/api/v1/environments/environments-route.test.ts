import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	environments: {
		list: vi.fn(async () => ({ environments: [{ id: "env-1" }] })),
		create: vi.fn(async () => ({ environment: { id: "env-2" } })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		environments: mocks.environments,
	}),
}));

import { GET, POST } from "./+server";

describe("/api/v1/environments route", () => {
	beforeEach(() => vi.clearAllMocks());

	it("keeps environment collection commands behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("environments.list");
		expect(source).toContain("environments.create");
		expect(source).not.toContain("$lib/server/environments/registry");
		expect(source).not.toContain("$lib/server/environments/builder");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates list and create requests", async () => {
		const url = new URL("http://localhost/api/v1/environments?q=python");
		const getResponse = await GET({
			url,
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(getResponse.status).toBe(200);
		await expect(getResponse.json()).resolves.toEqual({
			environments: [{ id: "env-1" }],
		});

		const body = { name: "Python" };
		const postResponse = await POST({
			request: new Request("http://localhost/api/v1/environments", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			locals: { session: { userId: "user-1", projectId: "project-1" } },
		} as never);
		expect(postResponse.status).toBe(201);
		await expect(postResponse.json()).resolves.toEqual({
			environment: { id: "env-2" },
		});
		expect(mocks.environments.list).toHaveBeenCalledWith({
			query: url.searchParams,
			sessionProjectId: "project-1",
		});
		expect(mocks.environments.create).toHaveBeenCalledWith({
			userId: "user-1",
			sessionProjectId: "project-1",
			body,
		});
	});
});

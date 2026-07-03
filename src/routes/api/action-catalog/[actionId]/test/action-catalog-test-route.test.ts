import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	actionCatalogTest: {
		execute: vi.fn(async () => ({ success: true, data: { ok: true } })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		actionCatalogTest: mocks.actionCatalogTest,
	}),
}));

import { POST } from "./+server";

describe("/api/action-catalog/[actionId]/test route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps action test execution behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("actionCatalogTest.execute");
		expect(source).not.toContain("$lib/server/action-catalog");
		expect(source).not.toContain("$lib/server/code-functions");
		expect(source).not.toContain("$lib/server/dapr-client");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates test execution to actionCatalogTest", async () => {
		const body = { input: { owner: "octo" } };
		const request = new Request(
			"http://localhost/api/action-catalog/github.create_issue/test",
			{
				method: "POST",
				body: JSON.stringify(body),
			},
		);

		const response = await POST({
			params: { actionId: "github.create_issue" },
			request,
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			success: true,
			data: { ok: true },
		});
		expect(mocks.actionCatalogTest.execute).toHaveBeenCalledWith({
			actionId: "github.create_issue",
			userId: "user-1",
			body,
		});
	});
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	catalogFunctionDefinition: {
		getDefinition: vi.fn(async () => ({ call: "github/create_issue" })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		catalogFunctionDefinition: mocks.catalogFunctionDefinition,
	}),
}));

import { GET } from "./+server";

describe("/api/catalog/functions/[name]/[version] route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps catalog function definition lookup behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("catalogFunctionDefinition.getDefinition");
		expect(source).not.toContain("$lib/server/code-functions");
		expect(source).not.toContain("$lib/server/action-catalog");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates definition lookup with session user context", async () => {
		const response = await GET({
			params: { name: "github/create_issue", version: "1.0.0" },
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			call: "github/create_issue",
		});
		expect(mocks.catalogFunctionDefinition.getDefinition).toHaveBeenCalledWith({
			name: "github/create_issue",
			version: "1.0.0",
			userId: "user-1",
		});
	});
});

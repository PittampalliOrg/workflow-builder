import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	codeFunctionManagement: {
		list: vi.fn(async () => [{ id: "fn-1", name: "Hello" }]),
		create: vi.fn(async () => ({ id: "fn-2", name: "Created" })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		codeFunctionManagement: mocks.codeFunctionManagement,
	}),
}));

import { GET, POST } from "./+server";

describe("/api/code-functions route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps code-function CRUD behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("codeFunctionManagement");
		expect(source).not.toContain("$lib/server/code-functions");
		expect(source).not.toContain("$lib/server/code-parser");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates list requests", async () => {
		const response = await GET({
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			functions: [{ id: "fn-1", name: "Hello" }],
			count: 1,
		});
		expect(mocks.codeFunctionManagement.list).toHaveBeenCalledWith({
			userId: "user-1",
		});
	});

	it("delegates create requests", async () => {
		const body = {
			name: "Created",
			language: "typescript",
			source: "export function main() {}",
		};
		const response = await POST({
			request: new Request("http://localhost/api/code-functions", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toEqual({
			id: "fn-2",
			name: "Created",
		});
		expect(mocks.codeFunctionManagement.create).toHaveBeenCalledWith({
			userId: "user-1",
			body,
		});
	});
});

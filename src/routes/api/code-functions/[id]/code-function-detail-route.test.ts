import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	codeFunctionManagement: {
		get: vi.fn(async () => ({ id: "fn-1", name: "Hello" })),
		update: vi.fn(async () => ({ id: "fn-1", name: "Updated" })),
		delete: vi.fn(async () => ({ success: true })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		codeFunctionManagement: mocks.codeFunctionManagement,
	}),
}));

import { DELETE, GET, PUT } from "./+server";

describe("/api/code-functions/[id] route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps code-function detail commands behind the application service", () => {
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

	it("delegates get, update, and delete requests", async () => {
		const getResponse = await GET({
			params: { id: "fn-1" },
			locals: { session: { userId: "user-1" } },
		} as never);
		expect(getResponse.status).toBe(200);
		await expect(getResponse.json()).resolves.toEqual({
			id: "fn-1",
			name: "Hello",
		});

		const body = {
			name: "Updated",
			language: "typescript",
			source: "export function main() {}",
		};
		const putResponse = await PUT({
			params: { id: "fn-1" },
			request: new Request("http://localhost/api/code-functions/fn-1", {
				method: "PUT",
				body: JSON.stringify(body),
			}),
			locals: { session: { userId: "user-1" } },
		} as never);
		expect(putResponse.status).toBe(200);
		await expect(putResponse.json()).resolves.toEqual({
			id: "fn-1",
			name: "Updated",
		});

		const deleteResponse = await DELETE({
			params: { id: "fn-1" },
			locals: { session: { userId: "user-1" } },
		} as never);
		expect(deleteResponse.status).toBe(200);
		await expect(deleteResponse.json()).resolves.toEqual({ success: true });

		expect(mocks.codeFunctionManagement.get).toHaveBeenCalledWith({
			id: "fn-1",
			userId: "user-1",
		});
		expect(mocks.codeFunctionManagement.update).toHaveBeenCalledWith({
			id: "fn-1",
			userId: "user-1",
			body,
		});
		expect(mocks.codeFunctionManagement.delete).toHaveBeenCalledWith({
			id: "fn-1",
			userId: "user-1",
		});
	});
});

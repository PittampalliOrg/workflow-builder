import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	codeFunctionExecution: {
		execute: vi.fn(async () => ({ success: true, data: { ok: true } })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		codeFunctionExecution: mocks.codeFunctionExecution,
	}),
}));

import { POST } from "./+server";

describe("/api/code-functions/[id]/execute route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps code-function execution behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("codeFunctionExecution.execute");
		expect(source).not.toContain("$lib/server/code-functions");
		expect(source).not.toContain("$lib/server/dapr-client");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates preview execution requests", async () => {
		const body = { input: { name: "Ada" } };
		const response = await POST({
			params: { id: "fn-1" },
			request: new Request("http://localhost/api/code-functions/fn-1/execute", {
				method: "POST",
				body: JSON.stringify(body),
			}),
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			success: true,
			data: { ok: true },
		});
		expect(mocks.codeFunctionExecution.execute).toHaveBeenCalledWith({
			id: "fn-1",
			userId: "user-1",
			body,
		});
	});
});

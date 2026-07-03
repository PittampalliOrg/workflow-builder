import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	codeFunctionManagement: {
		publish: vi.fn(async () => ({ id: "fn-1", latestPublishedVersion: "pub_1" })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		codeFunctionManagement: mocks.codeFunctionManagement,
	}),
}));

import { POST } from "./+server";

describe("/api/code-functions/[id]/publish route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps publish behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("codeFunctionManagement.publish");
		expect(source).not.toContain("$lib/server/code-functions");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates publish requests", async () => {
		const response = await POST({
			params: { id: "fn-1" },
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			id: "fn-1",
			latestPublishedVersion: "pub_1",
		});
		expect(mocks.codeFunctionManagement.publish).toHaveBeenCalledWith({
			id: "fn-1",
			userId: "user-1",
		});
	});
});

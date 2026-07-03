import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	codeFunctionOptions: {
		getOptions: vi.fn(async () => ({
			options: [{ label: "A", value: "a" }],
		})),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		codeFunctionOptions: mocks.codeFunctionOptions,
	}),
}));

import { POST } from "./+server";

describe("/api/code-functions/options route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps dynamic option execution behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("codeFunctionOptions.getOptions");
		expect(source).not.toContain("$lib/server/code-functions");
		expect(source).not.toContain("$lib/server/dapr-client");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates requests to codeFunctionOptions", async () => {
		const body = {
			functionRef: { id: "fn-1" },
			param: "calendar",
			input: { auth: "conn-1" },
		};
		const request = new Request("http://localhost/api/code-functions/options", {
			method: "POST",
			body: JSON.stringify(body),
		});

		const response = await POST({
			request,
			locals: { session: { userId: "user-1" } },
		} as never);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			options: [{ label: "A", value: "a" }],
		});
		expect(mocks.codeFunctionOptions.getOptions).toHaveBeenCalledWith({
			userId: "user-1",
			body,
		});
	});
});

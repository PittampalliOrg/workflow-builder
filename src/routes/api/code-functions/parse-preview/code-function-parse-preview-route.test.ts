import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	codeFunctionParsePreview: {
		parse: vi.fn(async () => ({ model: { entrypoint: "main" } })),
	},
}));

vi.mock("$lib/server/application", () => ({
	getApplicationAdapters: () => ({
		codeFunctionParsePreview: mocks.codeFunctionParsePreview,
	}),
}));

import { POST } from "./+server";

describe("/api/code-functions/parse-preview route", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("keeps code parsing behind the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("codeFunctionParsePreview.parse");
		expect(source).not.toContain("$lib/server/code-functions");
		expect(source).not.toContain("$lib/server/code-parser");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});

	it("delegates parse-preview requests", async () => {
		const body = {
			language: "typescript",
			source: "export function main() {}",
		};
		const response = await POST({
			request: new Request("http://localhost/api/code-functions/parse-preview", {
				method: "POST",
				body: JSON.stringify(body),
			}),
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			model: { entrypoint: "main" },
		});
		expect(mocks.codeFunctionParsePreview.parse).toHaveBeenCalledWith({ body });
	});
});

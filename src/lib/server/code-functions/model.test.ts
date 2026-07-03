import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
	buildCodeFunctionSourceHash,
	deriveCodeFunctionDependencies,
	normalizeCodeFunctionInput,
	slugifyCodeFunctionName,
} from "./model";

describe("code-functions module boundary", () => {
	it("keeps code-function model and facade free of direct DB/schema imports", () => {
		for (const file of ["./model.ts", "./index.ts"]) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("$lib/server/db/schema");
			expect(source).not.toContain("drizzle-orm");
		}
	});

	it("keeps migrated code-function callers off the legacy facade", () => {
		for (const file of [
			"../application/adapters/code-function-options.ts",
			"../application/adapters/code-function-execution.ts",
			"../application/adapters/action-options.ts",
			"../application/adapters/catalog-function-definition.ts",
			"../application/adapters/workflow-export.ts",
		]) {
			const source = readFileSync(new URL(file, import.meta.url), "utf8");
			expect(source).not.toContain("$lib/server/code-functions\"");
			expect(source).not.toContain("$lib/server/code-functions'");
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("drizzle-orm");
		}
	});
});

describe("code-function model helpers", () => {
	it("normalizes inputs and derives deterministic slugs, hashes, and dependencies", () => {
		expect(slugifyCodeFunctionName("  Hello, Calendar Tools! ")).toBe(
			"hello-calendar-tools",
		);
		expect(
			normalizeCodeFunctionInput({
				name: " Hello ",
				description: "  ",
				language: "typescript",
				entrypoint: " main ",
				source: "export function main() {}",
				supportingFiles: {
					" dep.ts ": "export const dep = 1;",
					ignored: 1 as unknown as string,
				},
			}),
		).toMatchObject({
			name: "Hello",
			description: null,
			entrypoint: "main",
			supportingFiles: { "dep.ts": "export const dep = 1;" },
			role: "function",
		});

		expect(
			buildCodeFunctionSourceHash("source", {
				"b.ts": "b",
				"a.ts": "a",
			}),
		).toBe(
			buildCodeFunctionSourceHash("source", {
				"a.ts": "a",
				"b.ts": "b",
			}),
		);

		expect(
			deriveCodeFunctionDependencies({
				language: "typescript",
				imports: [
					{ kind: "external", specifier: "npm:@microsoft/microsoft-graph-client" },
					{ kind: "external", specifier: "lodash/fp" },
					{ kind: "external", specifier: "node:fs" },
					{ kind: "relative", specifier: "./local" },
				],
			}),
		).toEqual(["@microsoft/microsoft-graph-client", "lodash"]);
	});
});

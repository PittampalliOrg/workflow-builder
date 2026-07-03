import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type { CodeFunctionDetail } from "$lib/server/code-functions/model";
import { resolveInlines } from "./inline-resolver";
import type { EmitNode } from "./ir";

const baseDetail: CodeFunctionDetail = {
	id: "fn-1",
	name: "Parse User",
	slug: "parse-user",
	description: null,
	version: "0.1.0",
	language: "typescript",
	entrypoint: "main",
	path: null,
	updatedAt: "2026-07-03T00:00:00.000Z",
	createdAt: "2026-07-03T00:00:00.000Z",
	isEnabled: true,
	hasDiagnostics: false,
	latestPublishedVersion: "pub-1",
	lastPublishedAt: null,
	role: "function",
	compositionGraph: null,
	source: "export function main(args) { return args.raw; }",
	supportingFiles: { "helper.ts": "export const helper = 1;" },
	sourceHash: "abc123",
	revisions: [],
	model: {
		language: "typescript",
		entrypoint: "main",
		is_async: false,
		imports: [],
		params: [],
		dynamic_inputs: [],
		return_type: { kind: "unknown" },
		schema: {},
		diagnostics: [],
		capabilities: {
			has_enums: false,
			has_nested_objects: false,
			has_nullable_types: false,
			has_relative_imports: false,
			has_resource_types: false,
			has_dynamic_inputs: false,
		},
	},
};

function callNode(): EmitNode {
	return {
		kind: "call",
		taskName: "parse",
		slug: "code/parse-user",
		args: { raw: "${ .trigger.text }" },
	};
}

describe("inline-resolver boundary", () => {
	it("does not import code-function persistence directly", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "inline-resolver.ts"),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/code-functions\"");
		expect(source).not.toContain("$lib/server/code-functions'");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

describe("resolveInlines", () => {
	it("inlines matching-language code functions through the injected reader", async () => {
		const warnings: string[] = [];
		const reader = {
			getCodeFunctionBySlugForUser: vi.fn(async () => baseDetail),
		};

		const result = await resolveInlines({
			steps: [callNode()],
			language: "typescript",
			userId: "user-1",
			warnings,
			codeFunctions: reader,
		});

		expect(reader.getCodeFunctionBySlugForUser).toHaveBeenCalledWith(
			"parse-user",
			"user-1",
		);
		expect(warnings).toEqual([]);
		expect(result.inlinedFunctions).toEqual([
			expect.objectContaining({
				identifier: "main",
				slug: "parse-user",
				version: "pub-1",
				language: "typescript",
				supportingFiles: { "helper.ts": "export const helper = 1;" },
			}),
		]);
		expect(result.steps[0]).toMatchObject({
			kind: "call",
			inlined: expect.objectContaining({ slug: "parse-user" }),
		});
	});

	it("leaves calls as shim dispatch when lookup misses, role is workflow, or language differs", async () => {
		for (const [detail, expectedWarning] of [
			[null, 'not found'],
			[{ ...baseDetail, role: "workflow" as const }, "role=workflow"],
			[{ ...baseDetail, language: "python" as const }, "is python"],
		] as const) {
			const warnings: string[] = [];
			const result = await resolveInlines({
				steps: [callNode()],
				language: "typescript",
				userId: "user-1",
				warnings,
				codeFunctions: {
					getCodeFunctionBySlugForUser: vi.fn(async () => detail),
				},
			});

			expect(warnings.join("\n")).toContain(expectedWarning);
			expect(result.inlinedFunctions).toEqual([]);
			expect(result.steps[0]).toEqual(callNode());
		}
	});
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildRuntimePreviewPath } from "$lib/server/workflows/runtime-preview-url";

describe("runtime preview URL helper", () => {
	it("builds workspace-scoped runtime preview paths", () => {
		expect(buildRuntimePreviewPath("exec 1", "workspace/one", "a=1")).toBe(
			"/workspaces/workspace%2Fone/workflows/runtime-preview/exec%201?a=1",
		);
		expect(buildRuntimePreviewPath("exec-1", "default", "?previewId=p1")).toBe(
			"/workspaces/default/workflows/runtime-preview/exec-1?previewId=p1",
		);
	});

	it("does not reach into infrastructure directly", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "runtime-preview-url.ts"),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});

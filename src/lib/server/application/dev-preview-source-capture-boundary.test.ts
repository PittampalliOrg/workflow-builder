import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("dev-preview source capture hexagonal boundary", () => {
	it("keeps the application use case dependent only on its outbound port", () => {
		const source = readFileSync(
			resolve(
				repoRoot,
				"src/lib/server/application/dev-preview-source-capture.ts",
			),
			"utf8",
		);
		const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
			(match) => match[1],
		);

		expect(imports).toEqual([
			"$lib/server/application/ports/dev-preview-source-capture",
		]);
		expect(source).not.toContain("$lib/server/workflows");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toMatch(/\bfetch\s*\(/);
	});

	it("confines the legacy capture helper to the outbound adapter", () => {
		const adapter = readFileSync(
			resolve(
				repoRoot,
				"src/lib/server/application/adapters/dev-preview-source-capture.ts",
			),
			"utf8",
		);
		const routes = [
			"src/routes/api/internal/workflows/executions/[executionId]/dev-preview/snapshot/+server.ts",
			"src/routes/api/internal/workflows/executions/[executionId]/dev-preview/promote/+server.ts",
		].map((path) => readFileSync(resolve(repoRoot, path), "utf8"));

		expect(adapter).toContain("captureAllDevPreviewSources");
		expect(adapter).toContain("$lib/server/workflows/dev-preview");
		for (const route of routes) {
			expect(route).toContain(
				"devPreviewSourceCapture.captureAcceptanceCandidate",
			);
			expect(route).not.toContain("$lib/server/workflows/dev-preview");
			expect(route).not.toContain("captureAllDevPreviewSources");
		}
	});
});

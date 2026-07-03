import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("internal benchmark run artifact route", () => {
	it("keeps artifact route and storage metadata free of direct DB imports", () => {
		const baseDir = dirname(fileURLToPath(import.meta.url));
		const routeSource = readFileSync(
			join(baseDir, "[runId]/artifacts/[...artifactPath]/+server.ts"),
			"utf8",
		);
		const storageSource = readFileSync(
			join(baseDir, "../../../../../lib/server/benchmarks/artifact-storage.ts"),
			"utf8",
		);

		expect(routeSource).toContain("BenchmarkArtifactKind");
		expect(storageSource).toContain("recordBenchmarkArtifact");
		for (const source of [routeSource, storageSource]) {
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("$lib/server/db/schema");
			expect(source).not.toContain("drizzle-orm");
		}
	});
});

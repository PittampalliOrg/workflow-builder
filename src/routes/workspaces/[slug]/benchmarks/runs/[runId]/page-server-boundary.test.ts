import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("benchmark run detail page server boundary", () => {
	it("delegates read-model construction to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+page.server.ts"),
			"utf8",
		);

		expect(source).toContain("benchmarkRunDetail.load");
		expect(source).not.toContain("$env/dynamic/private");
		expect(source).not.toContain("$lib/server/benchmarks/service");
		expect(source).not.toContain("$lib/server/benchmarks/stats");
		expect(source).not.toContain("$lib/server/benchmarks/capacity-diagnostics");
		expect(source).not.toContain("$lib/server/benchmarks/phase-attribution");
		expect(source).not.toContain("$lib/server/benchmarks/failure-context");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("benchmark run instance detail API route boundary", () => {
	it("delegates detail projection to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("benchmarkRunInstanceDetail.getDetail");
		expect(source).not.toContain("$lib/server/benchmarks/mlflow");
		expect(source).not.toContain("$lib/server/benchmarks/harness-result");
		expect(source).not.toContain("$lib/server/benchmarks/patch-compare");
		expect(source).not.toContain("$lib/server/benchmarks/contamination");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

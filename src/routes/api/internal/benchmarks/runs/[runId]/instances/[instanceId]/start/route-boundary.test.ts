import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("internal benchmark instance start route boundary", () => {
	it("delegates start behavior to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("benchmarkInstanceLifecycle.startBenchmarkInstanceWorkflow");
		expect(source).not.toContain("$lib/server/benchmarks/service");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

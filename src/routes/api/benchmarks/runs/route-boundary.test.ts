import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("benchmark runs route boundary", () => {
	it("delegates list and launch behavior to application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("benchmarkRunLaunch.listRuns");
		expect(source).toContain("benchmarkRunLaunch.startRun");
		expect(source).not.toContain("$lib/server/benchmarks/service");
		expect(source).not.toContain("$lib/server/benchmarks/agents");
		expect(source).not.toContain("$lib/server/dapr-client");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

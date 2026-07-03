import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("benchmark launch capacity API route boundary", () => {
	it("delegates capacity inspection to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("benchmarkCapacityDiagnostics.inspectLaunchCapacity");
		expect(source).not.toContain("$lib/server/benchmarks/agents");
		expect(source).not.toContain("$lib/server/benchmarks/capacity-diagnostics");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

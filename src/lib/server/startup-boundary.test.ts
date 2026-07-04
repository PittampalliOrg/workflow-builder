import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("startup environment maintenance boundary", () => {
	it("uses the application maintenance adapter instead of the legacy backfill helper", () => {
		const source = readFileSync(join(process.cwd(), "src/lib/server/startup.ts"), "utf8");

		expect(source).toContain("ApplicationEnvironmentService");
		expect(source).toContain("PostgresEnvironmentMaintenanceRepository");
		expect(source).not.toContain("$lib/server/environments/backfill");
		expect(source).not.toContain("backfillDefaultEnvironment");
		expect(source).not.toContain("repairBuiltinSandboxEnvironmentImages");
	});
});

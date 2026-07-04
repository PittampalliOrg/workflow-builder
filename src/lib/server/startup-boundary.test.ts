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

	it("has retired the in-app atlas migration pass (drizzle owns schema)", () => {
		const source = readFileSync(join(process.cwd(), "src/lib/server/startup.ts"), "utf8");

		// No atlas/migrations EXECUTION at boot — assert the machinery is gone (a
		// doc comment may still name atlas to explain the retirement, so we check
		// for code, not mentions): no directory/file read, no tracking table, no
		// per-file apply loop, no skip/env knobs for it.
		expect(source).not.toContain("MIGRATIONS_DIR");
		expect(source).not.toContain("readdirSync");
		expect(source).not.toContain("readFileSync");
		expect(source).not.toContain("_app_migrations");
		expect(source).not.toContain("runMigrations");
		expect(source).not.toContain("shouldSkipStartupMigrations");
		expect(source).not.toContain("RUN_MIGRATIONS");

		// The idempotent DATA backfill is preserved and remains the boot sequence.
		expect(source).toContain("runBackfills");
		expect(source).toContain("ensureStartupReady");
	});
});

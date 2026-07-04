import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("environment registry compatibility boundary", () => {
	it("has no direct DB, Drizzle, or schema imports", () => {
		const source = readFileSync(new URL("./registry.ts", import.meta.url), "utf8");

		expect(source).toContain("$lib/server/application/adapters/environment-registry");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
	});
});

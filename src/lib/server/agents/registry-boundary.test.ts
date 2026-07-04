import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("agent registry compatibility boundary", () => {
	it("keeps DB and Drizzle imports quarantined behind the application adapter", () => {
		const source = readFileSync(new URL("./registry.ts", import.meta.url), "utf8");

		expect(source).toContain("$lib/server/application/adapters/agent-registry");
		expect(source).not.toMatch(/from\s+["']drizzle-orm["']/);
		expect(source).not.toMatch(/from\s+["']\$lib\/server\/db(?:\/schema)?["']/);
	});
});

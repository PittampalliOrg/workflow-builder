import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("agent registry sync compatibility boundary", () => {
	it("keeps DB and Drizzle imports quarantined behind the application adapter", () => {
		const source = readFileSync(new URL("./registry-sync.ts", import.meta.url), "utf8");

		expect(source).toContain("$lib/server/application/adapters/agent-registry-sync");
		expect(source).not.toMatch(/from\s+["']drizzle-orm["']/);
		expect(source).not.toMatch(/from\s+["']\$lib\/server\/db(?:\/schema)?["']/);
	});
});

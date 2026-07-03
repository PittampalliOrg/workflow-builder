import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("settings CLI tokens page loader", () => {
	it("loads CLI token read model through the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+page.server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("settingsCliTokens.load");
		expect(source).not.toContain("$lib/server/agents/runtime-registry");
		expect(source).not.toContain("$lib/server/users/cli-credentials");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

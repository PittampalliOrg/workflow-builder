import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("social auth callback route boundary", () => {
	it("delegates social sign-in persistence to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters().authSignIn.signInSocial");
		expect(source).toContain("$lib/server/auth-cookies");
		expect(source).not.toContain("$lib/server/auth-social");
		expect(source).not.toContain("$lib/server/auth\"");
		expect(source).not.toContain("$lib/server/auth'");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("userIdentities");
		expect(source).not.toContain("platforms");
		expect(source).not.toContain("projects");
	});
});

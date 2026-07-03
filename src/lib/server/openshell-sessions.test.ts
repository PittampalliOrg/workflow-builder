import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("openshell session facade", () => {
	it("keeps route-facing OpenShell helpers free of direct DB imports", () => {
		const source = readFileSync(
			join(process.cwd(), "src/lib/server/openshell-sessions.ts"),
			"utf8",
		);

		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("$lib/server/sessions/registry");
	});
});

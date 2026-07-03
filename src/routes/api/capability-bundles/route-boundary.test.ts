import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const forbiddenImports = [
	"$lib/server/capabilities/registry",
	"$lib/server/db",
	"$lib/server/db/schema",
	"drizzle-orm",
];

describe("capability bundle route boundary", () => {
	it("delegates collection commands to the application service", () => {
		const root = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(join(root, "+server.ts"), "utf8");

		expect(source).toContain("capabilityBundles.listBundles");
		expect(source).toContain("capabilityBundles.createBundle");
		for (const forbidden of forbiddenImports) {
			expect(source).not.toContain(forbidden);
		}
	});

	it("delegates item commands to the application service", () => {
		const root = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(join(root, "[id]", "+server.ts"), "utf8");

		expect(source).toContain("capabilityBundles.getBundle");
		expect(source).toContain("capabilityBundles.updateBundle");
		expect(source).toContain("capabilityBundles.archiveBundle");
		for (const forbidden of forbiddenImports) {
			expect(source).not.toContain(forbidden);
		}
	});
});

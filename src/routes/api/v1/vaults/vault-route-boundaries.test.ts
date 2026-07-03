import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routeRoot = new URL(".", import.meta.url).pathname;

describe("vault route boundaries", () => {
	it.each([
		["+server.ts", ["vaults.list", "vaults.create"]],
		["[id]/+server.ts", ["vaults.get", "vaults.update", "vaults.archive"]],
	])("keeps %s metadata behind the vault service", (file, serviceCalls) => {
		const source = readFileSync(join(routeRoot, file), "utf8");
		for (const serviceCall of serviceCalls) {
			expect(source).toContain(serviceCall);
		}
		expect(source).not.toContain("$lib/server/vaults/registry");
		expect(source).not.toContain("$lib/server/vaults/credentials");
		expect(source).not.toContain("$lib/server/vaults/refresher");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

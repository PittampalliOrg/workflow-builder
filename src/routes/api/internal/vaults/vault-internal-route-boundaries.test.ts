import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routeRoot = new URL(".", import.meta.url).pathname;

describe("internal vault route boundaries", () => {
	it.each([
		["resolve/+server.ts", ["vaultCredentials.resolveForMcpServer"]],
		["refresh/+server.ts", ["vaultCredentials.refreshExpiring"]],
	])("keeps %s behind the vault credential service", (file, serviceCalls) => {
		const source = readFileSync(join(routeRoot, file), "utf8");
		for (const serviceCall of serviceCalls) {
			expect(source).toContain(serviceCall);
		}
		expect(source).not.toContain("$lib/server/vaults/credentials");
		expect(source).not.toContain("$lib/server/vaults/refresher");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

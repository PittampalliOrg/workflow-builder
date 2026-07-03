import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routeRoot = new URL(".", import.meta.url).pathname;

describe("vault credential route boundaries", () => {
	it.each([
		["[id]/credentials/+server.ts", ["vaultCredentials.list", "vaultCredentials.create"]],
		[
			"[id]/credentials/[credentialId]/+server.ts",
			[
				"vaultCredentials.get",
				"vaultCredentials.update",
				"vaultCredentials.archive",
			],
		],
		[
			"[id]/credentials/[credId]/refresh/+server.ts",
			["vaultCredentials.refreshOne"],
		],
	])("keeps %s behind the vault credential service", (file, serviceCalls) => {
		const source = readFileSync(join(routeRoot, file), "utf8");
		for (const serviceCall of serviceCalls) {
			expect(source).toContain(serviceCall);
		}
		expect(source).not.toContain("$lib/server/vaults/credentials");
		expect(source).not.toContain("$lib/server/vaults/refresher");
		expect(source).not.toContain("$lib/server/vaults/registry");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

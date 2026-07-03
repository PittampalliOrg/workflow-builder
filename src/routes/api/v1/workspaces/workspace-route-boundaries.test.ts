import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routeRoot = new URL(".", import.meta.url).pathname;

describe("workspace API route boundaries", () => {
	it.each([
		["+server.ts", ["listWorkspaces", "createWorkspace"]],
		["[id]/+server.ts", ["renameWorkspace"]],
	])("keeps %s behind the workspace registry facade", (file, serviceCalls) => {
		const source = readFileSync(join(routeRoot, file), "utf8");
		for (const serviceCall of serviceCalls) {
			expect(source).toContain(serviceCall);
		}
		expect(source).toContain("$lib/server/workspaces/registry");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});

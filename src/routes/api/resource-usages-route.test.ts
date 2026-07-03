import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeDir = dirname(fileURLToPath(import.meta.url));

const resourceUsageRoutes = [
	{
		path: "prompt-presets/[id]/usages/+server.ts",
		method: "getPromptPresetUsages",
	},
	{
		path: "agent-skills/[id]/used-by/+server.ts",
		method: "listAgentSkillUsedBy",
	},
	{
		path: "v1/vaults/[id]/usages/+server.ts",
		method: "getVaultUsages",
	},
];

describe("resource usage API routes", () => {
	it("load usage read models through workflow-data", () => {
		for (const route of resourceUsageRoutes) {
			const source = readFileSync(join(routeDir, route.path), "utf8");

			expect(source).toContain("getApplicationAdapters");
			expect(source).toContain(route.method);
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("$lib/server/db/schema");
			expect(source).not.toContain("drizzle-orm");
		}
	});
});

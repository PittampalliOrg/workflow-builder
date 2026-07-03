import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeFiles = [
	"+server.ts",
	"[id]/+server.ts",
	"search/+server.ts",
	"../admin/agent-skills/import/+server.ts",
	"../admin/agent-skills/import/zip/+server.ts",
	"../admin/agent-skills/[id]/enable/+server.ts",
	"../admin/agent-skills/[id]/disable/+server.ts",
];

const forbidden = [
	"$lib/server/agent-skills",
	"$lib/server/db",
	"$lib/server/db/schema",
	"drizzle-orm",
];

describe("agent skills route boundary", () => {
	it("routes skill management through the application service", () => {
		const root = dirname(fileURLToPath(import.meta.url));

		for (const file of routeFiles) {
			const source = readFileSync(join(root, file), "utf8");
			expect(source).toContain("agentSkills.");
			for (const token of forbidden) {
				expect(source).not.toContain(token);
			}
		}
	});
});

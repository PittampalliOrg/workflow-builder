import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeFiles = ["[name]/+server.ts", "batch/+server.ts"];
const forbidden = [
	"$lib/server/sandboxes/active-session-guard",
	"$lib/server/db",
	"$lib/server/db/schema",
	"drizzle-orm",
];

describe("sandbox active-session guard route boundary", () => {
	it("delegates active-session lookup to the application service", () => {
		const root = dirname(fileURLToPath(import.meta.url));
		for (const file of routeFiles) {
			const source = readFileSync(join(root, file), "utf8");
			expect(source).toContain("sandboxActiveGuard.activeSessionForSandboxName");
			for (const token of forbidden) {
				expect(source).not.toContain(token);
			}
		}
	});
});

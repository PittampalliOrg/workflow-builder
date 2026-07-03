import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeDir = dirname(fileURLToPath(import.meta.url));

describe("session stop routes", () => {
	it("delegates stop and stop-status decisions to the session lifecycle service", () => {
		for (const relative of ["+server.ts", "status/+server.ts"]) {
			const source = readFileSync(join(routeDir, relative), "utf8");

			expect(source).toContain("getApplicationAdapters");
			expect(source).toContain("sessionLifecycle");
			expect(source).not.toContain("$lib/server/lifecycle");
			expect(source).not.toContain("$lib/server/workflows/project-scope");
			expect(source).not.toContain("$lib/server/goals/repo");
			expect(source).not.toContain("$lib/server/lifecycle/ownership");
		}
	});
});

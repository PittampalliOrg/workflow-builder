import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeDir = dirname(fileURLToPath(import.meta.url));

describe("session lifecycle control routes", () => {
	it("delegates pause/resume/interrupt control to the session lifecycle service", () => {
		for (const route of ["pause", "resume", "interrupt"]) {
			const source = readFileSync(join(routeDir, route, "+server.ts"), "utf8");

			expect(source).toContain("getApplicationAdapters");
			expect(source).toContain("sessionLifecycle");
			expect(source).not.toContain("$lib/server/lifecycle");
			expect(source).not.toContain("$lib/server/workflows/project-scope");
			expect(source).not.toContain("$lib/server/goals/repo");
		}
	});
});

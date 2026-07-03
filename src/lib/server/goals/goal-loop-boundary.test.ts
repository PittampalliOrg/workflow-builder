import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("goal-loop persistence boundary", () => {
	it("does not import direct DB modules or application composition", () => {
		const source = readFileSync(
			join(process.cwd(), "src/lib/server/goals/goal-loop.ts"),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("./repo");
		expect(source).not.toContain("goals/repo");
		expect(source).not.toContain("getApplicationAdapters");
	});
});

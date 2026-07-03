import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeFiles = [
	"+server.ts",
	"logs/+server.ts",
	"llm-spans/+server.ts",
	"tool-spans/+server.ts",
	"investigation/+server.ts",
	"trace-access.ts",
];

describe("observability per-trace route access boundary", () => {
	it("routes trace access through the application service instead of direct DB helpers", () => {
		const root = dirname(fileURLToPath(import.meta.url));

		for (const file of routeFiles) {
			const source = readFileSync(join(root, file), "utf8");
			expect(source).not.toContain("$lib/server/observability/trace-scope");
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("$lib/server/db/schema");
			expect(source).not.toContain("drizzle-orm");
			expect(source).not.toContain("isResourceInScope");
		}

		const helperSource = readFileSync(join(root, "trace-access.ts"), "utf8");
		expect(helperSource).toContain("observabilityTraceAccess.assertTraceAccess");
	});
});

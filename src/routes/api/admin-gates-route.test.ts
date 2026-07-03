import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeDir = dirname(fileURLToPath(import.meta.url));

const adminGateRoutes = [
	"metrics/aggregate/+server.ts",
	"v1/gitops/deployment-metadata/+server.ts",
	"v1/gitops/promotions/+server.ts",
	"admin/pieces/[pieceName]/enable/+server.ts",
];

describe("admin-gated API routes", () => {
	it("resolve platform admin role through workflow-data", () => {
		for (const routePath of adminGateRoutes) {
			const source = readFileSync(join(routeDir, routePath), "utf8");

			expect(source).toContain("getApplicationAdapters");
			expect(source).toContain("isPlatformAdmin");
			expect(source).not.toContain("$lib/server/db");
			expect(source).not.toContain("$lib/server/db/schema");
			expect(source).not.toContain("drizzle-orm");
		}
	});
});

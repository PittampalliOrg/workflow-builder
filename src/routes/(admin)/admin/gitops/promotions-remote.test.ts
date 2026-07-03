import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("admin gitops promotions remote", () => {
	it("keeps direct Drizzle access out of the remote function", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "promotions.remote.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.isPlatformAdmin");
		expect(source).toContain("getPromotionStrategy");
		expect(source).toContain("query(\"unchecked\"");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});

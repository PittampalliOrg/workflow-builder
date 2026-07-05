import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("admin gitops data remote", () => {
	it("reads all GitOps state through the application layer, not Drizzle/domain modules", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "data.remote.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.isPlatformAdmin");
		// The four consolidated read queries.
		expect(source).toContain("getGitopsSnapshot");
		expect(source).toContain("getActivityEventsPage");
		expect(source).toContain("getPrPreviewStatuses");
		expect(source).toContain("gitOpsPromotions.getStrategy");
		// State is reached through the application layer, not the domain modules or
		// Drizzle directly.
		expect(source).not.toContain("$lib/server/promoter");
		expect(source).not.toContain("$lib/server/gitops/");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});

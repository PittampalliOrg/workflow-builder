import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("observability investigation boundary", () => {
	it("keeps workflow execution persistence behind the adapter", () => {
		const source = readFileSync(
			"src/lib/server/observability/investigation.ts",
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).toContain("ObservabilityInvestigationWorkflowReader");
		expect(source).toContain(
			"$lib/server/application/adapters/observability-investigation",
		);
	});
});

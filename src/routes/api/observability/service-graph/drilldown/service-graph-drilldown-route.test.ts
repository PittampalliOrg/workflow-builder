import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("observability service graph drilldown route", () => {
	it("scope-validates executions through workflow-data", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("getObservabilityServiceGraphContext");
		expect(source).toContain("workflowDiagnostics.getInvestigationEvidence");
		expect(source).toContain("buildExecutionInvestigationFromEvidence");
		expect(source).toContain("redactDiagnosticEvidence(scoped)");
		expect(source).not.toContain("resolveExecutionTraceIds");
		expect(source).not.toContain("$lib/server/otel");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("isResourceInScope");
	});
});

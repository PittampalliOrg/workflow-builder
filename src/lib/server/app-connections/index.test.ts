import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("App connections server helper", () => {
	it("delegates persistence to workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "index.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.listAppConnectionSummaries");
		expect(source).toContain("workflowData.decryptAppConnectionValue");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("appConnections");
		expect(source).not.toContain("platformOauthApps");
	});
});

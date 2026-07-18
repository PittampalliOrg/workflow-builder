import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("settings API keys route", () => {
	it("keeps API-key persistence behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.listUserApiKeys");
		expect(source).toContain("workflowData.createUserApiKey");
    expect(source).toContain("locals.session?.projectId");
    expect(source).toContain("Current session does not include a project");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("apiKeys.");
	});
});

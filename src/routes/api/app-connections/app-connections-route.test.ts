import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("App connections collection route", () => {
	it("keeps app-connection list/create persistence behind workflow-data services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.listProjectAppConnections");
		expect(source).toContain("workflowData.createProjectAppConnection");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("appConnections");
		expect(source).not.toContain("pieceMetadata");
		expect(source).not.toContain("encryptObject");
	});
});

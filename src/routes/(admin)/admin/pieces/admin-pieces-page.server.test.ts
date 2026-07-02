import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("admin pieces page server", () => {
	it("keeps piece catalog reads and toggles behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+page.server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getAdminPiecesReadModel");
		expect(source).toContain("workflowData.setAdminPieceEnabled");
		expect(source).toContain("workflowData.getUserProfile");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("platformDisabledPieces");
		expect(source).not.toContain("workflowConnectionRefs");
	});
});

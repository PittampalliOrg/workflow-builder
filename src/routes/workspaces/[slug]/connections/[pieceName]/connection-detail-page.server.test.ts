import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("workspace connection detail page loader", () => {
	it("keeps piece metadata and usage reads behind workflow-data application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+page.server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("workflowData.getPieceConnectionDetailPage");
		expect(source).not.toContain("$lib/server/mcp-catalog");
		expect(source).not.toContain("$lib/server/mcp-connections");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("workflowConnectionRefs");
		expect(source).not.toContain("pieceMetadata");
	});
});

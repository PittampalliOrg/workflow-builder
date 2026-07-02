import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Internal MCP project catalog route", () => {
	it("keeps catalog persistence behind workflow-data services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("workflowData.getInternalProjectMcpCatalog");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("$lib/server/db/mcp");
		expect(source).not.toContain("drizzle-orm");
		expect(source).not.toContain("mcpConnections");
	});
});

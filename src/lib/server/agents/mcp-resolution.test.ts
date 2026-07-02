import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("agent MCP resolution boundary", () => {
	it("keeps MCP persistence out of the pure resolver module", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "mcp-resolution.ts"),
			"utf8",
		);

		expect(source).toContain("resolveMcpServerConfigsFromRows");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("$lib/server/db/mcp");
		expect(source).not.toContain("drizzle-orm");
	});
});

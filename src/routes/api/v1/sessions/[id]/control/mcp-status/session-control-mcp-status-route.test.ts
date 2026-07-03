import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session control mcp status route", () => {
	it("delegates MCP status reads to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);
		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("sessionMcpStatus.getStatus");
		expect(source).not.toContain("workflowData.getSessionEventStreamSnapshot");
		expect(source).not.toContain("$lib/server/agents/registry");
		expect(source).not.toContain("$lib/server/vaults/credentials");
		expect(source).not.toContain("$lib/server/sessions/registry");
		expect(source).not.toContain("$lib/server/sessions/scope");
		expect(source).not.toContain("getSession(");
		expect(source).not.toContain("assertSessionInScope");
	});
});

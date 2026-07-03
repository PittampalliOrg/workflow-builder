import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("session CLI terminal resolve route", () => {
	it("delegates runtime preflight to the application service", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "+server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("sessionRuntimeAccess.resolveCliTerminal");
		expect(source).not.toContain("workflowData.getSessionRuntimeDebugTarget");
		expect(source).not.toContain("$lib/server/kube/client");
		expect(source).not.toContain("$lib/server/agents/runtime-registry");
		expect(source).not.toContain("$lib/server/sessions/runtime-target");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

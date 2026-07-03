import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routeDir = dirname(fileURLToPath(import.meta.url));

function readRoute(name: string): string {
	return readFileSync(join(routeDir, name, "+server.ts"), "utf8");
}

describe("session control agent-config routes", () => {
	it("delegates config patch commands to the application service", () => {
		for (const source of [
			readRoute("set-model"),
			readRoute("set-permission-mode"),
			readRoute("update-agent-config"),
		]) {
			expect(source).toContain("getApplicationAdapters");
			expect(source).toContain("sessionAgentConfig");
			expect(source).not.toContain("workflowData.raiseSessionAgentConfigPatch");
			expect(source).not.toContain("$lib/agents/model-options");
			expect(source).not.toContain("$lib/server/sessions/scope");
			expect(source).not.toContain("$lib/server/sessions/agent-config-patch");
			expect(source).not.toContain("assertSessionInScope");
			expect(source).not.toMatch(
				/import\s*\{[^}]*\braiseSessionAgentConfigPatch\b[^}]*\}\s*from\s*["']\$lib\/server\/sessions\/agent-config-patch["']/,
			);
		}
	});
});

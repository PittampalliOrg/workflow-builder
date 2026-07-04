import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("agent persistence adapter boundary", () => {
	it("keeps ephemeral-agent persistence in the application adapter layer", () => {
		const adapterSource = readFileSync(
			resolve(repoRoot, "src/lib/server/application/adapters/agents.ts"),
			"utf8",
		);

		expect(
			existsSync(resolve(repoRoot, "src/lib/server/agents/ephemeral.ts")),
		).toBe(false);
		expect(adapterSource).not.toContain("$lib/server/agents/ephemeral");
		expect(adapterSource).toContain("PostgresWorkflowEphemeralAgentStore");
	});
});

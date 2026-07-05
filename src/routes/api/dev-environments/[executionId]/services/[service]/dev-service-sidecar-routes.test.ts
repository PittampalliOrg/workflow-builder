import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("dev-service sidecar proxy routes (B5)", () => {
	it("sidecar-status resolves the pod from the project-scoped read model", () => {
		const source = readFileSync(join(here, "sidecar-status", "+server.ts"), "utf8");
		expect(source).toContain("locals.session?.userId");
		expect(source).toContain("workflowData.listDevEnvironments");
		expect(source).toContain("fetchSidecarStatus");
		expect(source).not.toContain("$lib/server/application/adapters");
		expect(source).not.toContain("$lib/server/db");
	});

	it("run validates the command against the registry allowlist server-side", () => {
		const source = readFileSync(join(here, "run", "+server.ts"), "utf8");
		expect(source).toContain("locals.session?.userId");
		expect(source).toContain("workflowData.listDevEnvironments");
		expect(source).toContain("runSidecarCommand");
		expect(source).not.toContain("$lib/server/application/adapters");
		expect(source).not.toContain("$lib/server/db");
	});
});

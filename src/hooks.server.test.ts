import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("server hooks boundary", () => {
	it("resolves request project scope through application services", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "hooks.server.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("authSession.getSession");
		expect(source).toContain("workflowData.resolveSessionProjectId");
		expect(source).toContain("resolveWorkspaceProjectId");
		expect(source).not.toMatch(/from ["']\$lib\/server\/auth["']/);
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const routeRoot = new URL(".", import.meta.url).pathname;

describe("environment route boundaries", () => {
	it.each([
		["+server.ts", ["environments.list", "environments.create"]],
		["[id]/+server.ts", ["environments.get", "environments.update", "environments.archive"]],
		["[id]/duplicate/+server.ts", ["environments.duplicate"]],
		["[id]/usages/+server.ts", ["environments.usages"]],
		["[id]/dockerfile-preview/+server.ts", ["environments.dockerfilePreview"]],
		["[id]/versions/+server.ts", ["environments.listVersions"]],
		[
			"[id]/versions/[version]/+server.ts",
			["environments.getVersion", "environments.restoreVersion"],
		],
	])("keeps %s behind the environment service", (file, serviceCalls) => {
		const source = readFileSync(join(routeRoot, file), "utf8");
		for (const serviceCall of serviceCalls) {
			expect(source).toContain(serviceCall);
		}
		expect(source).not.toContain("$lib/server/environments/registry");
		expect(source).not.toContain("$lib/server/environments/builder");
		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("drizzle-orm");
	});
});

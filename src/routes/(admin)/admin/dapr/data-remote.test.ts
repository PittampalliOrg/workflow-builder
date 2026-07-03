import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("admin dapr data remote", () => {
	it("keeps Dapr sidecar mechanics out of the presentation remote", () => {
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "data.remote.ts"),
			"utf8",
		);

		expect(source).toContain("getApplicationAdapters");
		expect(source).toContain("daprInspection");
		expect(source).toContain("query(\"unchecked\"");
		expect(source).not.toContain("$env/dynamic/private");
		expect(source).not.toContain("$lib/server/dapr-client");
		expect(source).not.toContain("getDaprSidecarUrl");
		expect(source).not.toContain("daprFetch");
		expect(source).not.toContain("getWorkflowCapableServices");
	});
});

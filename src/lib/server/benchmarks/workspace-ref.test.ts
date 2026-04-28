import { describe, expect, it } from "vitest";
import { buildStableWorkspaceRef } from "./workspace-ref";

describe("buildStableWorkspaceRef", () => {
	it("keeps the uniqueness hash near the front for downstream truncation", () => {
		const first = buildStableWorkspaceRef("swebench", [
			"run-with-a-long-shared-prefix",
			"psf__requests-1963",
		]);
		const second = buildStableWorkspaceRef("swebench", [
			"run-with-a-long-shared-prefix",
			"pallets__flask-4045",
		]);

		expect(first).not.toBe(second);
		expect(first.slice(0, 24)).not.toBe(second.slice(0, 24));
		expect(first).toMatch(/^swebench-[0-9a-f]{10}-/);
		expect(second).toMatch(/^swebench-[0-9a-f]{10}-/);
	});
});

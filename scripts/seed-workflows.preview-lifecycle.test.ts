import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("seed-workflows preview lifecycle schema", () => {
	it("exposes retainOnFailure in the host lifecycle launch input", () => {
		const source = fs.readFileSync(
			path.resolve(process.cwd(), "scripts/seed-workflows.ts"),
			"utf8",
		);
		const lifecycleStart = source.indexOf("function hostPreviewLifecycleDefinition()");
		const ganStart = source.indexOf("function previewUiDevelopmentGanDefinition()");
		expect(lifecycleStart).toBeGreaterThanOrEqual(0);
		expect(ganStart).toBeGreaterThan(lifecycleStart);
		const lifecycleSource = source.slice(lifecycleStart, ganStart);

		expect(lifecycleSource).toContain("retainAfterCompletion");
		expect(lifecycleSource).toContain("retainOnFailure");
	});
});

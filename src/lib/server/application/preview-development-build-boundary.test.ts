import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("preview development build hexagonal boundary", () => {
	it("keeps orchestration dependent on ports instead of infrastructure", () => {
		const source = readFileSync(
			resolve(
				process.cwd(),
				"src/lib/server/application/preview-development-build.ts",
			),
			"utf8",
		);
		const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map(
			(match) => match[1],
		);
		expect(imports).toEqual(["$lib/server/application/ports"]);
		expect(source).not.toContain("$lib/server/workflows");
		expect(source).not.toContain("$lib/server/kube");
		expect(source).not.toMatch(/\bfetch\s*\(/);
	});

	it("confines Tekton and the canonical registry to the outbound adapter", () => {
		const adapter = readFileSync(
			resolve(
				process.cwd(),
				"src/lib/server/application/adapters/preview-development-build.ts",
			),
			"utf8",
		);
		expect(adapter).toContain("$lib/server/kube/tekton");
		expect(adapter).toContain("$lib/server/workflows/dev-preview-registry");
		expect(adapter).toContain('targetCluster: TARGET_CLUSTER');
	});
});

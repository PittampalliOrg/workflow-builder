import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("preview acceptance trust hexagonal boundary", () => {
	it("keeps cryptography and artifact persistence behind outbound ports", () => {
		const service = readFileSync(
			resolve(
				repoRoot,
				"src/lib/server/application/preview-acceptance-trust.ts",
			),
			"utf8",
		);
		const imports = [...service.matchAll(/from\s+["']([^"']+)["']/g)].map(
			(match) => match[1],
		);

		expect(imports).toEqual([
			"$lib/server/application/ports/preview-acceptance-trust",
		]);
		expect(service).not.toContain("node:crypto");
		expect(service).not.toContain("$env/");
		expect(service).not.toContain("$lib/server/db");
	});

	it("keeps preview routes on composed application services", () => {
		const routePaths = [
			"src/routes/api/internal/workflows/executions/[executionId]/dev-preview/promote/+server.ts",
			"src/routes/api/internal/workflows/executions/[executionId]/dev-preview/acceptance/+server.ts",
		];
		for (const path of routePaths) {
			const route = readFileSync(resolve(repoRoot, path), "utf8");
			expect(route).toContain("getApplicationAdapters");
			expect(route).not.toContain("application/adapters");
			expect(route).not.toContain("node:crypto");
			expect(route).not.toContain("$lib/server/db");
		}
	});

	it("implements the append-once guard in both artifact persistence adapters", () => {
		const postgres = readFileSync(
			resolve(repoRoot, "src/lib/server/application/adapters/postgres.ts"),
			"utf8",
		);
		const daprPostgres = readFileSync(
			resolve(
				repoRoot,
				"src/lib/server/application/adapters/workflow-artifacts-dapr-postgres.ts",
			),
			"utf8",
		);

		expect(postgres).toContain("ifAbsentMetadataKey");
		expect(postgres).toContain("COALESCE");
		expect(postgres).toContain("? ${input.ifAbsentMetadataKey}");
		expect(daprPostgres).toContain("ifAbsentMetadataKey");
		expect(daprPostgres).toContain("COALESCE");
		expect(daprPostgres).toContain("? $4");
		expect(daprPostgres).toContain("result.rowsAffected !== 1");
	});
});

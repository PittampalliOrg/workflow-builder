import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));

const INTENTIONAL_DIFFERENCES: Record<string, string> = {
	"@activepieces/piece-gitea":
		"fn-activepieces owns the custom Gitea execution path; no piece-mcp KService is registered for it yet.",
	"@activepieces/piece-github":
		"piece-mcp-server is pinned to the validated MCP-compatible GitHub piece until the newer fn-activepieces version is checked.",
};

function packageJson(path: string): { dependencies?: Record<string, string> } {
	return JSON.parse(readFileSync(path, "utf8"));
}

function apPieceDeps(pkg: { dependencies?: Record<string, string> }): Record<string, string> {
	return Object.fromEntries(
		Object.entries(pkg.dependencies ?? {}).filter(([name]) =>
			name.startsWith("@activepieces/piece-"),
		),
	);
}

describe("ActivePieces package registry parity", () => {
	it("keeps fn-activepieces and piece-mcp-server package sets aligned", () => {
		const fnDeps = apPieceDeps(
			packageJson(resolve(__dirname, "../../fn-activepieces/package.json")),
		);
		const mcpDeps = apPieceDeps(
			packageJson(resolve(__dirname, "../package.json")),
		);
		const packageNames = new Set([...Object.keys(fnDeps), ...Object.keys(mcpDeps)]);

		const diffs = [...packageNames]
			.sort()
			.flatMap((name) => {
				const fnVersion = fnDeps[name] ?? null;
				const mcpVersion = mcpDeps[name] ?? null;
				return fnVersion === mcpVersion
					? []
					: [{ name, fnVersion, mcpVersion }];
			});
		const unexpected = diffs.filter((diff) => !(diff.name in INTENTIONAL_DIFFERENCES));

		expect(unexpected).toEqual([]);
		for (const [name, reason] of Object.entries(INTENTIONAL_DIFFERENCES)) {
			expect(reason, name).toBeTruthy();
		}
	});
});

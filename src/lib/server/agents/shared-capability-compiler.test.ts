import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

// The capability compiler (services/shared/capability_compiler/) is the SSOT for
// translating an agent's declared MCP servers onto each runtime's native shape.
// It is vendored byte-identical (package .py modules only — tests/ excluded) into
// each Python agent runtime's build context. These guards fail if a vendored copy
// is edited directly instead of the canonical + `node scripts/sync-runtime-registry.mjs`.
const CANONICAL_DIR = "services/shared/capability_compiler";
const COPY_DIRS = [
	"services/dapr-agent-py/src/capability_compiler",
	"services/claude-agent-py/src/capability_compiler",
	"services/cli-agent-py/src/capability_compiler"
];

function read(rel: string): string {
	return readFileSync(resolve(process.cwd(), rel), "utf8");
}

// Package modules vendored (mirrors the script's tests/ + __pycache__ exclusion).
const MODULES = readdirSync(resolve(process.cwd(), CANONICAL_DIR)).filter((f) => f.endsWith(".py")).sort();

describe("shared capability compiler — drift guard", () => {
	it("canonical exposes the three per-target emitters", () => {
		const mcp = read(join(CANONICAL_DIR, "mcp.py"));
		for (const sym of [
			"def emit_dapr_agent_py(",
			"def emit_claude_code_cli_servers(",
			"def emit_claude_agent_sdk_servers("
		]) {
			expect(mcp.includes(sym), `missing ${sym}`).toBe(true);
		}
	});

	for (const dir of COPY_DIRS) {
		for (const mod of MODULES) {
			it(`${dir}/${mod} is byte-identical to the canonical SSOT`, () => {
				expect(read(join(dir, mod))).toBe(read(join(CANONICAL_DIR, mod)));
			});
		}

		it(`${dir} has no stale modules beyond the canonical set`, () => {
			const vendored = readdirSync(resolve(process.cwd(), dir)).filter((f) => f.endsWith(".py")).sort();
			expect(vendored).toEqual(MODULES);
		});
	}
});

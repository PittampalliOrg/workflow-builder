import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeIdFromChildSessionId } from "./resolvers";

describe("nodeIdFromChildSessionId", () => {
	it("keeps lifecycle resolver contracts free of infrastructure imports", () => {
		const source = readFileSync(
			join(process.cwd(), "src/lib/server/lifecycle/resolvers.ts"),
			"utf8",
		);

		expect(source).not.toContain("$lib/server/db");
		expect(source).not.toContain("$lib/server/db/schema");
		expect(source).not.toContain("drizzle-orm");
	});

	// The per-runtime instance prefixes from services/shared/runtime-registry.json.
	// The wedge gate (resolvers.terminatedChildNodes → shouldForceFinalizeCrossAppWedge)
	// only works if the node id is extracted for EVERY runtime, not just dapr-agent-py.
	const PREFIXES = [
		"durable", // dapr-agent-py (default)
		"durable-claude", // claude-agent-py
		"durable-adk", // adk-agent-py
		"durable-browser-use", // browser-use-agent
		"durable-claude-cli",
		"durable-codex-cli",
		"durable-agy-cli",
		"durable-testing",
	];

	it("extracts the node id for every runtime instance prefix", () => {
		for (const prefix of PREFIXES) {
			const childId = `exec123__${prefix}__build_3b1b_animation__run__0`;
			expect(
				nodeIdFromChildSessionId(childId),
				`prefix ${prefix} should yield the node id`,
			).toBe("build_3b1b_animation");
		}
	});

	it("handles multi-digit run indices and node ids with separators", () => {
		expect(nodeIdFromChildSessionId("e__durable-claude__node_a-b__run__12")).toBe("node_a-b");
		expect(nodeIdFromChildSessionId("e__durable__synthesize__run__0")).toBe("synthesize");
	});

	it("returns null for a non-workflow-driven (direct) session id", () => {
		expect(nodeIdFromChildSessionId("sess_abc123")).toBeNull();
		expect(nodeIdFromChildSessionId("agent-session-deadbeef")).toBeNull();
	});

	it("does not match a bare instanceId without the __run__N suffix", () => {
		expect(nodeIdFromChildSessionId("exec__durable__node")).toBeNull();
	});
});

import { describe, expect, it } from "vitest";
import { buildSwebenchInstanceWorkflowSpec } from "./service";

describe("SWE-bench workflow spec", () => {
	it("uses a POSIX-compatible checkout command", () => {
		const spec = buildSwebenchInstanceWorkflowSpec({
			suiteSlug: "SWE-bench_Lite",
			datasetName: "princeton-nlp/SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "abc123",
			problemStatement: "Fix it",
			hintsText: null,
			agentId: "agent_1",
			agentVersion: 1,
			timeoutSeconds: 7200,
			maxTurns: null,
		});

		const checkout = (spec.do as Array<Record<string, { with: { command: string } }>>)[1]
			.checkout_repo;
		expect(checkout.with.command).toContain("set -eu\n");
		expect(checkout.with.command).not.toContain("pipefail");
	});

	it("extracts patches against the SWE-bench base commit", () => {
		const spec = buildSwebenchInstanceWorkflowSpec({
			suiteSlug: "SWE-bench_Lite",
			datasetName: "princeton-nlp/SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			problemStatement: "Fix it",
			hintsText: null,
			agentId: "agent_1",
			agentVersion: 1,
			timeoutSeconds: 7200,
			maxTurns: null,
		});

		const extractPatch = (
			spec.do as Array<Record<string, { with: { command: string } }>>
		)[3].extract_patch;
		expect(extractPatch.with.command).toBe(
			"cd /sandbox/repo && git diff --binary 'cffd4e0f86fefd4802349a9f9b19ed70934ea354' --",
		);
	});
});

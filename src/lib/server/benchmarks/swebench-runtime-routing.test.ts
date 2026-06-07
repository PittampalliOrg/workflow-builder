import { describe, expect, it } from "vitest";
import { buildSwebenchInstanceWorkflowSpec } from "./service";
import type { ResolvedSwebenchInferenceEnvironment } from "./inference-environments";

// Item 5 — SWE-bench de-branch. `buildSwebenchInstanceWorkflowSpec` used to gate
// the final output mapping on the `agentRuntime === "claude-agent-py"` literal;
// it now reads the registry `capabilities.ownsSandbox` capability, conformance-
// gated. These tests pin the resulting jq output expressions per runtime so the
// de-branch stays behavior-preserving and the adk flip stays gated on item 6.

const inferenceEnvironment: ResolvedSwebenchInferenceEnvironment = {
	environmentStatus: "validated",
	suite: "SWE-bench_Verified",
	repo: "astropy/astropy",
	sandboxTemplate: "dapr-agent",
	sandboxImage: "ghcr.io/pittampalliorg/swebench-env:test",
};

function outputAsFor(agentRuntime: string | null | undefined): Record<string, unknown> {
	const spec = buildSwebenchInstanceWorkflowSpec({
		suiteSlug: "SWE-bench_Verified",
		datasetName: "princeton-nlp/SWE-bench_Verified",
		instanceId: "astropy__astropy-12345",
		repo: "astropy/astropy",
		baseCommit: "0123456789abcdef0123456789abcdef01234567",
		problemStatement: "Fix the failing test.",
		hintsText: null,
		agentId: "agent-1",
		agentVersion: 1,
		timeoutSeconds: 600,
		maxTurns: 50,
		inferenceEnvironment,
		agentRuntime,
	}) as { output: { as: Record<string, unknown> } };
	return spec.output.as;
}

const SOLVE_MODEL_PATCH = "${ .solve.modelPatch // .extract_patch.modelPatch }";
const EXTRACT_MODEL_PATCH = "${ .extract_patch.modelPatch }";
const SOLVE_WORKSPACE_REF = "${ .solve.runtimeSandboxName // .workspace_profile.workspaceRef }";
const EXTRACT_WORKSPACE_REF = "${ .workspace_profile.workspaceRef }";
const SOLVE_SANDBOX_NAME = "${ .solve.runtimeSandboxName // .workspace_profile.sandboxName }";
const EXTRACT_SANDBOX_NAME = "${ .workspace_profile.sandboxName }";

describe("SWE-bench solve-sandbox routing (ownsSandbox de-branch)", () => {
	it("claude-agent-py (ownsSandbox, production-verified reference) → .solve.* path", () => {
		// Behavior-preserving: identical to the old isClaudeAgentRuntime===true branch.
		const as = outputAsFor("claude-agent-py");
		expect(as.modelPatch).toBe(SOLVE_MODEL_PATCH);
		expect(as.workspaceRef).toBe(SOLVE_WORKSPACE_REF);
		expect(as.sandboxName).toBe(SOLVE_SANDBOX_NAME);
	});

	it("dapr-agent-py (ownsSandbox:false) → .extract_patch.* path", () => {
		// Behavior-preserving: identical to the old isClaudeAgentRuntime===false branch.
		const as = outputAsFor("dapr-agent-py");
		expect(as.modelPatch).toBe(EXTRACT_MODEL_PATCH);
		expect(as.workspaceRef).toBe(EXTRACT_WORKSPACE_REF);
		expect(as.sandboxName).toBe(EXTRACT_SANDBOX_NAME);
	});

	it("adk-agent-py (ownsSandbox:true but unverified) stays on .extract_patch.* — gated on item 6", () => {
		// The one real behavior change is GATED: adk declares ownsSandbox but its
		// solve-output shape is unverified (capabilitiesVerified:false, not in the
		// reference set), so it must NOT route through .solve.* until item 6's
		// conformance harness flips its flag.
		const as = outputAsFor("adk-agent-py");
		expect(as.modelPatch).toBe(EXTRACT_MODEL_PATCH);
		expect(as.workspaceRef).toBe(EXTRACT_WORKSPACE_REF);
		expect(as.sandboxName).toBe(EXTRACT_SANDBOX_NAME);
	});

	it("dapr-agent-py-testing (ownsSandbox:false, verified) → .extract_patch.* path", () => {
		// Verified does NOT imply solve-sandbox — ownsSandbox is the primary gate.
		const as = outputAsFor("dapr-agent-py-testing");
		expect(as.modelPatch).toBe(EXTRACT_MODEL_PATCH);
	});

	it("unknown / unset runtime falls back to the safe .extract_patch.* path", () => {
		expect(outputAsFor(undefined).modelPatch).toBe(EXTRACT_MODEL_PATCH);
		expect(outputAsFor(null).modelPatch).toBe(EXTRACT_MODEL_PATCH);
		expect(outputAsFor("does-not-exist").modelPatch).toBe(EXTRACT_MODEL_PATCH);
	});

	it("the routing-independent fields are stable across runtimes", () => {
		for (const rt of ["claude-agent-py", "dapr-agent-py", "adk-agent-py"]) {
			const as = outputAsFor(rt);
			expect(as.sessionId).toBe("${ .solve.sessionId // .solve.agentWorkflowId // null }");
			expect(as.runtimeSandboxName).toBe("${ .solve.runtimeSandboxName // null }");
			expect(as.instanceId).toBe("astropy__astropy-12345");
		}
	});
});

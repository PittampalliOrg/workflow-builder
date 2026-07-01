import { describe, expect, it } from "vitest";
import { evaluatePromotionGate } from "./promotion-gates";

describe("evaluatePromotionGate", () => {
	it("does not gate non-preview bundles", () => {
		const gate = evaluatePromotionGate({
			mode: "pr",
			artifactPayload: { tier: "full" },
			executionOutput: null,
			summaryOutput: null,
		});
		expect(gate.required).toBe(false);
		expect(gate.allowed).toBe(true);
	});

	it("does not gate branch-only exports", () => {
		const gate = evaluatePromotionGate({
			mode: "branch",
			artifactPayload: { tier: "tar-overlay", iteration: 0 },
			executionOutput: null,
			summaryOutput: null,
		});
		expect(gate.required).toBe(false);
		expect(gate.allowed).toBe(true);
	});

	it("blocks preview PR promotion without an accepted verdict", () => {
		const gate = evaluatePromotionGate({
			mode: "pr",
			artifactPayload: { tier: "tar-overlay", iteration: 0 },
			executionOutput: { accepted: false, verdict: { meets_criteria: false, score: 9 } },
			summaryOutput: null,
		});
		expect(gate.required).toBe(true);
		expect(gate.allowed).toBe(false);
		expect(gate.reason).toBe("accepted_false_or_missing");
	});

	it("blocks preview PR promotion below the default score threshold", () => {
		const gate = evaluatePromotionGate({
			mode: "pr",
			artifactPayload: { tier: "tar-overlay", iteration: 0 },
			executionOutput: { accepted: true, iterations: 1, verdict: { meets_criteria: true, score: 7.9 } },
			summaryOutput: null,
		});
		expect(gate.allowed).toBe(false);
		expect(gate.reason).toBe("score_below_threshold");
	});

	it("blocks non-accepted iterations when the accepted iteration is known", () => {
		const gate = evaluatePromotionGate({
			mode: "pr",
			artifactPayload: { tier: "tar-overlay", iteration: 1 },
			executionOutput: { accepted: true, iterations: 3, verdict: { meets_criteria: true, score: 9 } },
			summaryOutput: null,
		});
		expect(gate.allowed).toBe(false);
		expect(gate.reason).toBe("artifact_not_accepted_iteration");
		expect(gate.acceptedIteration).toBe(2);
	});

	it("allows the accepted preview iteration", () => {
		const gate = evaluatePromotionGate({
			mode: "pr",
			artifactPayload: { tier: "tar-overlay", iteration: 2 },
			executionOutput: { accepted: true, iterations: 3, verdict: { meets_criteria: true, score: 9.2 } },
			summaryOutput: null,
		});
		expect(gate.allowed).toBe(true);
		expect(gate.reason).toBe("accepted");
	});

	it("allows final preview captures when the run passed", () => {
		const gate = evaluatePromotionGate({
			mode: "pr",
			artifactPayload: { tier: "tar-overlay", iteration: null },
			executionOutput: null,
			summaryOutput: { accepted: true, verdict: { meets_criteria: true, score: 92 } },
		});
		expect(gate.allowed).toBe(true);
		expect(gate.score).toBe(9.2);
	});
});

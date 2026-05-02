import { describe, expect, it } from "vitest";
import {
	canTransitionBenchmarkRun,
	summarizeRunInstances,
} from "./swebench";

describe("benchmark run state transitions", () => {
	it("allows the normal queued -> inferencing -> evaluating -> completed path", () => {
		expect(canTransitionBenchmarkRun("queued", "inferencing")).toBe(true);
		expect(canTransitionBenchmarkRun("inferencing", "evaluating")).toBe(true);
		expect(canTransitionBenchmarkRun("evaluating", "completed")).toBe(true);
	});

	it("rejects transitions out of terminal states", () => {
		expect(canTransitionBenchmarkRun("completed", "failed")).toBe(false);
		expect(canTransitionBenchmarkRun("failed", "queued")).toBe(false);
		expect(canTransitionBenchmarkRun("cancelled", "inferencing")).toBe(false);
	});

	it("allows redrives from failed back into evaluating + completed", () => {
		expect(canTransitionBenchmarkRun("failed", "evaluating")).toBe(true);
		expect(canTransitionBenchmarkRun("failed", "completed")).toBe(true);
		// completed and cancelled remain hard-terminal.
		expect(canTransitionBenchmarkRun("completed", "evaluating")).toBe(false);
		expect(canTransitionBenchmarkRun("cancelled", "completed")).toBe(false);
	});

	it("computes resolved-rate summaries", () => {
		expect(summarizeRunInstances(["resolved", "failed", "resolved"])).toMatchObject({
			total: 3,
			resolved: 2,
			failed: 1,
			resolvedRate: 2 / 3,
		});
	});
});

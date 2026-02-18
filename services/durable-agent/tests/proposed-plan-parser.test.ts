import { describe, expect, it } from "vitest";
import {
	extractProposedPlanText,
	stripProposedPlanBlocks,
} from "../src/service/proposed-plan-parser.js";

describe("proposed-plan-parser", () => {
	it("extracts proposed plan block", () => {
		const input = [
			"Intro",
			"<proposed_plan>",
			"- step 1",
			"- step 2",
			"</proposed_plan>",
			"Outro",
		].join("\n");
		expect(extractProposedPlanText(input)).toBe("- step 1\n- step 2\n");
	});

	it("uses last proposed plan block if multiple", () => {
		const input = [
			"<proposed_plan>",
			"- old",
			"</proposed_plan>",
			"<proposed_plan>",
			"- latest",
			"</proposed_plan>",
		].join("\n");
		expect(extractProposedPlanText(input)).toBe("- latest\n");
	});

	it("closes unterminated proposed plan block at end", () => {
		const input = "<proposed_plan>\n- step 1\n";
		expect(extractProposedPlanText(input)).toBe("- step 1\n");
	});

	it("ignores non-standalone tag lines", () => {
		const input = "prefix <proposed_plan>\n- step 1\n</proposed_plan>\n";
		expect(extractProposedPlanText(input)).toBeNull();
	});

	it("strips proposed plan blocks from text", () => {
		const input = "before\n<proposed_plan>\n- step\n</proposed_plan>\nafter\n";
		expect(stripProposedPlanBlocks(input)).toBe("before\nafter\n");
	});
});

import { describe, expect, it } from "vitest";

import { shortTag, statusVariant } from "./gitops-display";

describe("shortTag", () => {
	it("renders a full 40-hex git tag as git-<8-hex>", () => {
		expect(shortTag("git-5ae1c36c21473c41b2153179b4b063f8c3766625")).toBe("git-5ae1c36c");
	});

	it("renders a short git tag unchanged", () => {
		expect(shortTag("git-5ae1c36c")).toBe("git-5ae1c36c");
	});

	it("passes short non-git tags through", () => {
		expect(shortTag("latest")).toBe("latest");
		expect(shortTag("v1.2.3")).toBe("v1.2.3");
	});

	it("truncates long non-git tags with an ellipsis", () => {
		expect(shortTag("this-is-a-very-long-tag-that-wraps")).toBe("this-is-a-very-…");
	});

	it("returns an em-dash for nullish input", () => {
		expect(shortTag(null)).toBe("—");
		expect(shortTag(undefined)).toBe("—");
	});

	it("respects a custom maxChars for non-git tags", () => {
		expect(shortTag("a-moderately-long-tag", 10)).toBe("a-moderat…");
	});
});

describe("statusVariant", () => {
	it("treats both title-case and lowercase passing states as secondary", () => {
		for (const s of ["Synced", "Healthy", "Succeeded", "True", "success", "healthy", "succeeded"]) {
			expect(statusVariant(s)).toBe("secondary");
		}
	});

	it("returns destructive for failure states", () => {
		for (const s of ["OutOfSync", "Degraded", "Failed", "Failure", "False", "failed"]) {
			expect(statusVariant(s)).toBe("destructive");
		}
	});

	it("returns outline for unknown / null", () => {
		expect(statusVariant(null)).toBe("outline");
		expect(statusVariant("")).toBe("outline");
		expect(statusVariant("Progressing")).toBe("outline");
	});
});

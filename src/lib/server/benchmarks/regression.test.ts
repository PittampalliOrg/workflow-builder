import { describe, expect, it } from "vitest";
import { fisherExact, welchTTest } from "./regression";

describe("fisherExact", () => {
	it("returns p≈1 for identical 2×2 tables", () => {
		// 5/10 vs 5/10 — perfect agreement, large p
		const p = fisherExact(5, 5, 5, 5);
		expect(p).toBeCloseTo(1, 1);
	});

	it("returns small p for clear divergence (10/10 vs 0/10)", () => {
		const p = fisherExact(10, 0, 0, 10);
		expect(p).toBeLessThan(0.001);
	});

	it("matches the canonical 'Lady tasting tea' example", () => {
		// Fisher's original: 4/4 vs 0/4 → p ≈ 0.0286 (one-tail). Two-tail ~0.057.
		const p = fisherExact(4, 0, 0, 4);
		expect(p).toBeGreaterThan(0.02);
		expect(p).toBeLessThan(0.07);
	});

	it("handles all-zero rows or columns gracefully", () => {
		expect(fisherExact(0, 0, 5, 5)).toBe(1);
		expect(fisherExact(0, 5, 0, 5)).toBe(1);
	});

	it("returns p approaching 1 for one-instance equal-resolved runs", () => {
		// Common SWE-bench scenario: 1 instance each, both resolved.
		// We don't expect significance — there's only 1 sample per side.
		const p = fisherExact(1, 0, 1, 0);
		expect(p).toBe(1);
	});

	it("is symmetric in the two rows", () => {
		const p1 = fisherExact(3, 7, 7, 3);
		const p2 = fisherExact(7, 3, 3, 7);
		expect(p1).toBeCloseTo(p2, 6);
	});
});

describe("welchTTest", () => {
	it("returns p=1 when both samples are identical", () => {
		const { pValue } = welchTTest([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]);
		expect(pValue).toBeCloseTo(1, 3);
	});

	it("returns small p for clearly different means + low variance", () => {
		const { pValue } = welchTTest(
			[10, 10.1, 10, 9.9, 10],
			[5, 5.1, 5, 4.9, 5],
		);
		expect(pValue).toBeLessThan(0.001);
	});

	it("returns p=1 when either sample has fewer than 2 points", () => {
		expect(welchTTest([1], [1, 2, 3]).pValue).toBe(1);
		expect(welchTTest([], [1, 2, 3]).pValue).toBe(1);
		expect(welchTTest([1, 2, 3], [1]).pValue).toBe(1);
	});

	it("matches a known textbook example (slightly different means, large n)", () => {
		// Same mean ± moderate spread, n=20 each — should NOT be significant.
		const a = [4.8, 5.2, 5.0, 4.9, 5.1, 4.7, 5.3, 5.0, 4.9, 5.1,
			4.8, 5.2, 5.0, 4.9, 5.1, 4.7, 5.3, 5.0, 4.9, 5.1];
		const b = [5.0, 5.4, 5.2, 5.1, 5.3, 4.9, 5.5, 5.2, 5.1, 5.3,
			5.0, 5.4, 5.2, 5.1, 5.3, 4.9, 5.5, 5.2, 5.1, 5.3];
		// Means differ by 0.2 with sd~0.18 → t ≈ 3.5, p < 0.01
		const { pValue } = welchTTest(a, b);
		expect(pValue).toBeLessThan(0.01);
	});

	it("returns p≈1 when stddev is zero in both", () => {
		const { pValue } = welchTTest([5, 5, 5, 5], [5, 5, 5, 5]);
		expect(pValue).toBe(1);
	});
});

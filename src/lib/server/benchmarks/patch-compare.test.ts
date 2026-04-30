import { describe, expect, it } from "vitest";
import { compareToGold, parsePatchStats } from "./patch-compare";

const MODEL_PATCH = `diff --git a/src/foo.py b/src/foo.py
--- a/src/foo.py
+++ b/src/foo.py
@@ -1,4 +1,5 @@
 def foo():
-    return 1
+    return 2
+    # extra
 def bar():
     pass
diff --git a/src/baz.py b/src/baz.py
--- a/src/baz.py
+++ b/src/baz.py
@@ -10,3 +10,3 @@
-old
+new
 unchanged
`;

const GOLD_PATCH = `diff --git a/src/foo.py b/src/foo.py
--- a/src/foo.py
+++ b/src/foo.py
@@ -1,3 +1,3 @@
 def foo():
-    return 1
+    return 2
 def bar():
`;

describe("parsePatchStats", () => {
	it("counts adds, removes, and files in a multi-file unified diff", () => {
		const stats = parsePatchStats(MODEL_PATCH);
		expect(stats.addedLines).toBe(3);
		expect(stats.removedLines).toBe(2);
		expect(stats.filesTouched).toEqual(["src/baz.py", "src/foo.py"]);
		expect(stats.wellFormed).toBe(true);
	});

	it("returns empty stats for null/empty/whitespace input", () => {
		for (const input of [null, undefined, "", "   \n  \n"]) {
			const stats = parsePatchStats(input);
			expect(stats.addedLines).toBe(0);
			expect(stats.removedLines).toBe(0);
			expect(stats.filesTouched).toEqual([]);
			expect(stats.wellFormed).toBe(false);
		}
	});

	it("flags non-diff content as not well-formed", () => {
		const stats = parsePatchStats("just some prose, not a diff");
		expect(stats.wellFormed).toBe(false);
	});

	it("accepts patches without `diff --git` headers (--- a/path / +++ b/path only)", () => {
		const headerless = `--- a/src/foo.py
+++ b/src/foo.py
@@ -1,2 +1,2 @@
-old
+new
`;
		const stats = parsePatchStats(headerless);
		expect(stats.wellFormed).toBe(true);
		expect(stats.filesTouched).toEqual(["src/foo.py"]);
		expect(stats.addedLines).toBe(1);
		expect(stats.removedLines).toBe(1);
	});

	it("does not double-count the +++ / --- header lines", () => {
		const stats = parsePatchStats(MODEL_PATCH);
		expect(stats.addedLines).toBe(3);
		expect(stats.removedLines).toBe(2);
	});

	it("rejects a patch with file headers but no hunks", () => {
		const noHunk = `diff --git a/src/foo.py b/src/foo.py
--- a/src/foo.py
+++ b/src/foo.py
`;
		const stats = parsePatchStats(noHunk);
		expect(stats.wellFormed).toBe(false);
	});
});

describe("compareToGold", () => {
	it("computes file overlap with the gold patch", () => {
		const overlap = compareToGold(MODEL_PATCH, GOLD_PATCH);
		expect(overlap.filesOverlap).toBe(1);
		expect(overlap.filesOverlapList).toEqual(["src/foo.py"]);
	});

	it("returns zero overlap when the model touched the wrong file", () => {
		const wrongFile = `diff --git a/docs/README.md b/docs/README.md
--- a/docs/README.md
+++ b/docs/README.md
@@ -1,1 +1,2 @@
 hi
+more
`;
		const overlap = compareToGold(wrongFile, GOLD_PATCH);
		expect(overlap.filesOverlap).toBe(0);
		expect(overlap.filesOverlapList).toEqual([]);
	});

	it("handles missing model or gold patches", () => {
		expect(compareToGold(null, GOLD_PATCH).filesOverlap).toBe(0);
		expect(compareToGold(MODEL_PATCH, null).filesOverlap).toBe(0);
		expect(compareToGold(null, null).filesOverlap).toBe(0);
	});
});

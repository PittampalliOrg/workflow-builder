import { describe, expect, it } from "vitest";
import { stripDiffStatPreamble } from "./unified-diff";

describe("stripDiffStatPreamble", () => {
	it("drops a git diff --stat summary before the first hunk", () => {
		const input = [
			" src/a.ts | 2 +-",
			" 1 file changed, 1 insertion(+), 1 deletion(-)",
			"",
			"diff --git a/src/a.ts b/src/a.ts",
			"index 111..222 100644",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1 +1 @@",
			"-old",
			"+new",
		].join("\n");
		expect(stripDiffStatPreamble(input)).toBe(
			[
				"diff --git a/src/a.ts b/src/a.ts",
				"index 111..222 100644",
				"--- a/src/a.ts",
				"+++ b/src/a.ts",
				"@@ -1 +1 @@",
				"-old",
				"+new",
			].join("\n"),
		);
	});

	it("is a no-op for a bare patch that already starts with diff --git", () => {
		const patch = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b";
		expect(stripDiffStatPreamble(patch)).toBe(patch);
	});

	it("returns non-git diffs untouched", () => {
		const patch = "--- a\n+++ b\n@@ -1 +1 @@\n-a\n+b";
		expect(stripDiffStatPreamble(patch)).toBe(patch);
	});

	it("returns empty string for empty input", () => {
		expect(stripDiffStatPreamble("")).toBe("");
	});
});

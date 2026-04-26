import { describe, expect, it } from "vitest";
import {
	buildPredictionsJsonl,
	buildSwebenchPrediction,
	normalizeInstanceIds,
	normalizeSwebenchInstance,
	normalizeSwebenchSuiteSlug,
	repoFromInstanceId,
} from "./swebench";

describe("SWE-bench normalization", () => {
	it("normalizes supported suite aliases", () => {
		expect(normalizeSwebenchSuiteSlug("verified")).toBe("SWE-bench_Verified");
		expect(normalizeSwebenchSuiteSlug("SWE bench lite")).toBe("SWE-bench_Lite");
	});

	it("deduplicates comma/newline instance ids", () => {
		expect(normalizeInstanceIds("sympy__sympy-20590, django__django-11099\nsympy__sympy-20590")).toEqual([
			"sympy__sympy-20590",
			"django__django-11099",
		]);
	});

	it("derives repo and preserves test metadata", () => {
		const normalized = normalizeSwebenchInstance({
			instance_id: "sympy__sympy-20590",
			base_commit: "abc123",
			problem_statement: "Fix it",
			hints_text: "Look here",
			patch: "gold",
			FAIL_TO_PASS: ["test_a"],
			PASS_TO_PASS: ["test_b"],
		});
		expect(normalized.repo).toBe("sympy/sympy");
		expect(normalized.baseCommit).toBe("abc123");
		expect(normalized.testMetadata.FAIL_TO_PASS).toEqual(["test_a"]);
		expect(normalized.goldPatch).toBe("gold");
	});

	it("builds official JSONL prediction rows", () => {
		const jsonl = buildPredictionsJsonl([
			buildSwebenchPrediction({
				instanceId: "sympy__sympy-20590",
				modelNameOrPath: "agent-v1",
				modelPatch: "diff --git a/a b/a",
			}),
		]);
		expect(jsonl).toBe(
			'{"instance_id":"sympy__sympy-20590","model_name_or_path":"agent-v1","model_patch":"diff --git a/a b/a"}\n',
		);
	});

	it("derives repos from canonical instance ids", () => {
		expect(repoFromInstanceId("django__django-11099")).toBe("django/django");
		expect(repoFromInstanceId("not-canonical")).toBeNull();
	});
});

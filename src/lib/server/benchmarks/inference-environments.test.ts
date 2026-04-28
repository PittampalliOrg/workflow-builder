import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSwebenchInferenceEnvironment } from "./inference-environments";

const env = {
	SWEBENCH_INFERENCE_ENVIRONMENTS_JSON: JSON.stringify({
		environments: [
			{
				suite: "SWE-bench_Lite",
				repo: "sympy/sympy",
				version: "1.7",
				environmentKey: "sympy-1.7",
				sandboxImage:
					"gitea-ryzen.tail286401.ts.net/giteaadmin/swebench-inference-sympy-1.7:git-abc123",
				digest:
					"sha256:1111111111111111111111111111111111111111111111111111111111111111",
				validationStatus: "validated",
				validationLogRef: "tekton://swebench-inference-image-build/validate-image",
				builtAt: "2026-04-28T12:00:00Z",
			},
		],
	}),
};

describe("SWE-bench inference environment resolver", () => {
	it("returns a digest-pinned validated image for a known SymPy mapping", () => {
		const resolved = resolveSwebenchInferenceEnvironment(
			{
				suiteSlug: "SWE-bench_Lite",
				repo: "sympy/sympy",
				baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
				testMetadata: { version: "1.7" },
			},
			{ env },
		);

		expect(resolved).toMatchObject({
			environmentStatus: "validated",
			environmentKey: "sympy-1.7",
			sandboxTemplate: "dapr-agent",
			digest:
				"sha256:1111111111111111111111111111111111111111111111111111111111111111",
			validationStatus: "validated",
		});
		expect(resolved.sandboxImage).toBe(
			"gitea-ryzen.tail286401.ts.net/giteaadmin/swebench-inference-sympy-1.7:git-abc123@sha256:1111111111111111111111111111111111111111111111111111111111111111",
		);
	});

	it("falls back to dapr-agent when no validated mapping exists", () => {
		const resolved = resolveSwebenchInferenceEnvironment(
			{
				suiteSlug: "SWE-bench_Lite",
				repo: "django/django",
				baseCommit: "abc123",
				testMetadata: { version: "3.2" },
			},
			{ env },
		);

		expect(resolved).toEqual({
			environmentStatus: "fallback",
			suite: "SWE-bench_Lite",
			repo: "django/django",
			version: "3.2",
			baseCommit: "abc123",
			sandboxTemplate: "dapr-agent",
			reason: "no_validated_mapping",
		});
	});

	it("loads a single mapping object from a mounted ConfigMap file", () => {
		const dir = mkdtempSync(join(tmpdir(), "swebench-inference-"));
		try {
			writeFileSync(
				join(dir, "swe-bench-lite.sympy_sympy.sympy-1.7.json"),
				JSON.stringify({
					suite: "SWE-bench_Lite",
					repo: "sympy/sympy",
					version: "1.7",
					environmentKey: "sympy-1.7",
					sandboxImage: "ghcr.io/pittampalliorg/swebench-inference-sympy-1.7:git-abc123",
					digest:
						"sha256:2222222222222222222222222222222222222222222222222222222222222222",
					validationStatus: "validated",
				}),
			);

			const resolved = resolveSwebenchInferenceEnvironment(
				{
					suiteSlug: "SWE-bench_Lite",
					repo: "sympy/sympy",
					baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
					testMetadata: { version: "1.7" },
				},
				{ env: { SWEBENCH_INFERENCE_ENVIRONMENTS_DIR: dir } },
			);

			expect(resolved.environmentStatus).toBe("validated");
			expect(resolved.sandboxImage).toBe(
				"ghcr.io/pittampalliorg/swebench-inference-sympy-1.7:git-abc123@sha256:2222222222222222222222222222222222222222222222222222222222222222",
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

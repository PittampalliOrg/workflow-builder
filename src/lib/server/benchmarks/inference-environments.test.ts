import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	isExactValidatedSwebenchInferenceEnvironment,
	resolveSwebenchInferenceEnvironment,
} from "./inference-environments";

const env = {
	SWEBENCH_INFERENCE_ENVIRONMENTS_JSON: JSON.stringify({
		environments: [
			{
				suite: "SWE-bench_Lite",
				repo: "sympy/sympy",
				version: "1.7",
				baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
				environmentKey: "sympy-1.7",
				sandboxImage:
					"gitea-ryzen.tail286401.ts.net/giteaadmin/swebench-inference-sympy-1.7:git-abc123",
				digest:
					"sha256:1111111111111111111111111111111111111111111111111111111111111111",
				validationStatus: "validated",
				validationLogRef: "tekton://swebench-inference-image-build/validate-image",
				validationCommand: "PYTHONPATH=src python -m pytest --version",
				buildStrategy: "swebench-harness",
				envSpecHash: "a".repeat(64),
				workspaceRoot: "/testbed",
				condaEnvironment: "testbed",
				swebenchSpec: {
					instanceImageKey: "sweb.eval.x86_64.sympy__sympy-20590:latest",
				},
				environmentNotes: [
					"Run Python commands with PYTHONPATH=src for source-layout repos.",
				],
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
			"a".repeat(64),
			{ env },
		);

		expect(resolved).toMatchObject({
			environmentStatus: "validated",
			environmentKey: "sympy-1.7",
			sandboxTemplate: "dapr-agent",
			digest:
				"sha256:1111111111111111111111111111111111111111111111111111111111111111",
			validationStatus: "validated",
			validationCommand: "PYTHONPATH=src python -m pytest --version",
			buildStrategy: "swebench-harness",
			envSpecHash: "a".repeat(64),
			workspaceRoot: "/sandbox/repo",
			condaEnvironment: "testbed",
			swebenchSpec: {
				instanceImageKey: "sweb.eval.x86_64.sympy__sympy-20590:latest",
			},
			environmentNotes: expect.arrayContaining([
				"Run Python commands with PYTHONPATH=src for source-layout repos.",
				"The validated image provides the SWE-bench Python environment; the repository is cloned into /sandbox/repo for OpenShell runtime access.",
				"Use python or /sandbox/.venv/bin/python for local checks; avoid conda activation inside the solve phase.",
			]),
		});
		expect(resolved.sandboxImage).toBe(
			"gitea-ryzen.tail286401.ts.net/giteaadmin/swebench-inference-sympy-1.7:git-abc123@sha256:1111111111111111111111111111111111111111111111111111111111111111",
		);
	});

	it("requires exact identity before marking a mapping random-launch ready", () => {
		expect(
			isExactValidatedSwebenchInferenceEnvironment(
				{
					suiteSlug: "SWE-bench_Lite",
					repo: "sympy/sympy",
					baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
					testMetadata: { version: "1.7" },
				},
				"a".repeat(64),
				{ env },
			),
		).toBe(true);

		expect(
			isExactValidatedSwebenchInferenceEnvironment(
				{
					suiteSlug: "SWE-bench_Lite",
					repo: "sympy/sympy",
					baseCommit: "different-base-commit",
					testMetadata: { version: "1.7" },
				},
				"a".repeat(64),
				{ env },
			),
		).toBe(false);
	});

	it("accepts exact static pins that omit environment setup commit", () => {
		expect(
			isExactValidatedSwebenchInferenceEnvironment(
				{
					suiteSlug: "SWE-bench_Lite",
					repo: "sympy/sympy",
					baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
					testMetadata: {
						version: "1.7",
						environment_setup_commit: "metadata-only-env-setup",
					},
				},
				"a".repeat(64),
				{ env },
			),
		).toBe(true);
	});

	it("falls back to dapr-agent when no validated mapping exists", () => {
		const resolved = resolveSwebenchInferenceEnvironment(
			{
				suiteSlug: "SWE-bench_Lite",
				repo: "django/django",
				baseCommit: "abc123",
				testMetadata: { version: "3.2" },
			},
			"a".repeat(64),
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
					envSpecHash: "c".repeat(64),
				}),
			);

			const resolved = resolveSwebenchInferenceEnvironment(
				{
					suiteSlug: "SWE-bench_Lite",
					repo: "sympy/sympy",
					baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
					testMetadata: { version: "1.7" },
				},
				"c".repeat(64),
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

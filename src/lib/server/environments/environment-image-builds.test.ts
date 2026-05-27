import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => {
	const state: { lastUpdate: Record<string, unknown> | null } = { lastUpdate: null };
	const selectLimit = vi.fn<() => Promise<Array<Record<string, unknown>>>>(async () => []);
	const selectWhere = vi.fn(() => ({ limit: selectLimit }));
	const selectFrom = vi.fn(() => ({ where: selectWhere }));
	const select = vi.fn(() => ({ from: selectFrom }));
	const updateReturning = vi.fn();
	const updateSet = vi.fn((value: Record<string, unknown>) => {
		state.lastUpdate = value;
		return { where: vi.fn(() => ({ returning: updateReturning })) };
	});
	const insertValues = vi.fn(() => ({
		onConflictDoUpdate: vi.fn(async () => undefined),
	}));
	return { state, select, selectFrom, selectWhere, selectLimit, updateReturning, updateSet, insertValues };
});

const tektonMocks = vi.hoisted(() => ({
	createTektonPipelineRun: vi.fn(),
	getTektonPipelineRun: vi.fn(),
	listTektonTaskRunsForPipelineRun: vi.fn(),
}));

vi.mock("$lib/server/db", () => ({
	db: {
		select: dbMocks.select,
		insert: vi.fn(() => ({ values: dbMocks.insertValues })),
		update: vi.fn(() => ({ set: dbMocks.updateSet })),
	},
}));

vi.mock("$lib/server/kube/tekton", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/kube/tekton")>();
	return {
		...actual,
		createTektonPipelineRun: tektonMocks.createTektonPipelineRun,
		getTektonPipelineRun: tektonMocks.getTektonPipelineRun,
		listTektonTaskRunsForPipelineRun: tektonMocks.listTektonTaskRunsForPipelineRun,
	};
});

import {
	buildSwebenchEnvironmentSpec,
	buildSwebenchPipelineRunManifest,
	buildSwebenchPrebuiltPipelineRunManifest,
	ensureSwebenchEnvironment,
	hasUsableValidatedImage,
	normalizeEnvironmentBuildActivityEvents,
	plannedSwebenchInferenceEnvironment,
	runtimeSafeEnvironment,
	selectSwebenchBuildahCacheShard,
	syncEnvironmentBuild,
} from "./environment-image-builds";

describe("SWE-bench environment image build planning", () => {
	beforeEach(() => {
		dbMocks.state.lastUpdate = null;
		dbMocks.select.mockClear();
		dbMocks.selectFrom.mockClear();
		dbMocks.selectWhere.mockClear();
		dbMocks.selectLimit.mockReset();
		dbMocks.selectLimit.mockResolvedValue([]);
		dbMocks.insertValues.mockClear();
		dbMocks.updateSet.mockClear();
		dbMocks.updateReturning.mockReset();
		tektonMocks.createTektonPipelineRun.mockReset();
		tektonMocks.getTektonPipelineRun.mockReset();
		tektonMocks.listTektonTaskRunsForPipelineRun.mockReset();
		tektonMocks.listTektonTaskRunsForPipelineRun.mockResolvedValue([]);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("builds a stable dynamic image spec from repo metadata", () => {
		const spec = buildSwebenchEnvironmentSpec({
			dataset: "princeton-nlp/SWE-bench_Lite",
			suiteSlug: "SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
				validationCommand: "PYTHONPATH=src python -m pytest --version",
			},
		});

		expect(spec).toMatchObject({
			dataset: "princeton-nlp/SWE-bench_Lite",
			suite: "SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			version: "1.7",
			environmentKey: "sympy-1.7",
			buildStrategy: "swebench-harness",
			sandboxTemplate: "dapr-agent",
			imageName: "swebench-inference-sympy-1.7",
			imageTag: expect.stringMatching(/^env-[0-9a-f]{16}$/),
			dockerfilePath: "Dockerfile",
			validationCommand: "PYTHONPATH=src python -m pytest --version",
			workspaceRoot: "/sandbox/repo",
			condaEnvironment: "testbed",
		});
		expect(spec.swebenchSpecInput).toMatchObject({
			instance_id: "sympy__sympy-20590",
			repo: "sympy/sympy",
			version: "1.7",
			base_commit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
		});
		expect(spec.envSpecHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it("preserves trailing whitespace in test_patch (unidiff context-line marker)", () => {
		// django__django-13128 in SWE-bench_Verified ends with ` \n\n` —
		// the single-space-on-its-own-line is the empty-source-line context
		// marker, counted by the hunk header. Trimming desyncs the hunk count
		// and breaks `unidiff.PatchSet(...)` inside the harness.
		const patchWithTrailingMarker =
			"diff --git a/tests/x.py b/tests/x.py\n" +
			"--- a/tests/x.py\n" +
			"+++ b/tests/x.py\n" +
			"@@ -1,3 +1,2 @@\n" +
			" first_line\n" +
			"-second_line\n" +
			" \n\n";
		const spec = buildSwebenchEnvironmentSpec({
			dataset: "princeton-nlp/SWE-bench_Verified",
			suiteSlug: "SWE-bench_Verified",
			instanceId: "django__django-13128",
			repo: "django/django",
			baseCommit: "2d67222472f80f251607ae1b720527afceba06ad",
			testMetadata: {
				version: "3.2",
				test_patch: patchWithTrailingMarker,
				FAIL_TO_PASS: [],
				PASS_TO_PASS: [],
			},
		});
		expect(spec.swebenchSpecInput?.test_patch).toBe(patchWithTrailingMarker);
		// Defensive: also verify the trailing 3 bytes survived (most likely-to-be-stripped slice).
		expect(
			(spec.swebenchSpecInput?.test_patch as string).endsWith(" \n\n"),
		).toBe(true);
	});

	it("plans a dynamic build instead of returning a template fallback", () => {
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_JSON", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_FILE", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_DIR", "");

		const planned = plannedSwebenchInferenceEnvironment({
			suiteSlug: "SWE-bench_Lite",
			repo: "django/django",
			baseCommit: "abc123",
			testMetadata: {
				version: "3.2",
				test_patch: "diff --git a/tests/test_dummy.py b/tests/test_dummy.py\n",
			},
		});

		expect(planned).toMatchObject({
			environmentStatus: "building",
			suite: "SWE-bench_Lite",
			repo: "django/django",
			version: "3.2",
			environmentKey: "django-3.2",
			sandboxTemplate: "dapr-agent",
			buildStrategy: "swebench-harness",
			source: "dynamic-build",
			reason: "dynamic_build_required",
			workspaceRoot: "/sandbox/repo",
			condaEnvironment: "testbed",
		});
		expect(planned.environmentNotes).toContain(
			"The validated image provides the SWE-bench Python environment; the repository is cloned into /sandbox/repo for OpenShell runtime access.",
		);
		expect(planned.environmentNotes).toContain(
			"Use python or /sandbox/.venv/bin/python for local checks; avoid conda activation inside the solve phase.",
		);
		expect(planned).toHaveProperty("envSpecHash");
		expect(planned).not.toHaveProperty("sandboxImage");
	});

	it("redacts hidden SWE-bench image metadata from runtime environment output", () => {
		const runtimeEnvironment = runtimeSafeEnvironment({
			environmentStatus: "validated",
			suite: "SWE-bench_Lite",
			repo: "sympy/sympy",
			version: "1.7",
			environmentKey: "sympy-1.7",
			sandboxTemplate: "dapr-agent",
			sandboxImage:
				"ghcr.io/pittampalliorg/swebench-inference-sympy-1.7:env-abc@sha256:1111111111111111111111111111111111111111111111111111111111111111",
			digest:
				"sha256:1111111111111111111111111111111111111111111111111111111111111111",
			validationStatus: "validated",
			validationCommand: "cd /testbed && python -m pytest --version",
			workspaceRoot: "/testbed",
			condaEnvironment: "testbed",
			buildStrategy: "swebench-harness",
			swebenchSpec: {
				workspaceRoot: "/testbed",
				testPatchHash: "abc123",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
			},
			environmentNotes: [
				"The repository is already prepared under /testbed at the SWE-bench base commit.",
				"Use python or /sandbox/.venv/bin/python for local checks; avoid conda activation inside the solve phase.",
			],
		});

		const serialized = JSON.stringify(runtimeEnvironment);
		expect(runtimeEnvironment).toMatchObject({
			workspaceRoot: "/sandbox/repo",
			environmentStatus: "validated",
			environmentKey: "sympy-1.7",
		});
		expect(runtimeEnvironment).not.toHaveProperty("validationCommand");
		expect(runtimeEnvironment).not.toHaveProperty("swebenchSpec");
		expect(serialized).not.toContain("/testbed");
		expect(serialized).not.toMatch(/test[_-]?patch/i);
		expect(serialized).not.toContain("FAIL_TO_PASS");
		expect(serialized).not.toContain("PASS_TO_PASS");
		expect(serialized).not.toContain("goldPatch");
	});

	it("falls back to buildpacks only when harness metadata is missing", () => {
		const spec = buildSwebenchEnvironmentSpec({
			suiteSlug: "SWE-bench_Lite",
			instanceId: "django__django-11099",
			repo: "django/django",
			baseCommit: "abc123",
			testMetadata: {},
		});

		expect(spec).toMatchObject({
			buildStrategy: "buildpacks",
			workspaceRoot: "/sandbox/repo",
			fallbackReason: "missing_swebench_version",
		});
		expect(spec.dockerfilePath).toContain("Dockerfile.swebench-inference-django-abc123");
	});

	it("falls back to buildpacks when the repo exists but the version is not in SWE-bench specs", () => {
		const spec = buildSwebenchEnvironmentSpec({
			suiteSlug: "SWE-bench_Lite",
			instanceId: "django__django-99999",
			repo: "django/django",
			baseCommit: "abc123",
			testMetadata: {
				version: "9.9",
				test_patch: "diff --git a/tests/test_dummy.py b/tests/test_dummy.py\n",
			},
		});

		expect(spec).toMatchObject({
			buildStrategy: "buildpacks",
			workspaceRoot: "/sandbox/repo",
			fallbackReason: "unsupported_swebench_harness_version",
		});
	});

	it("does not submit dynamic SWE-bench image builds without explicit permission", async () => {
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_JSON", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_FILE", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_DIR", "");
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE", "local");

		const result = await ensureSwebenchEnvironment({
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
			},
		});

		expect(result).toMatchObject({
			success: false,
			complete: true,
			status: "failed",
			reason: "dynamic_build_not_allowed",
		});
		expect(tektonMocks.createTektonPipelineRun).not.toHaveBeenCalled();
		expect(dbMocks.insertValues).not.toHaveBeenCalled();
	});

	it("keeps current static SWE-bench mappings even when legacy refresh is requested", async () => {
		const exactSpec = buildSwebenchEnvironmentSpec({
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
			},
		});
		vi.stubEnv(
			"SWEBENCH_INFERENCE_ENVIRONMENTS_JSON",
			JSON.stringify([
				{
					suite: "SWE-bench_Verified",
					repo: "sympy/sympy",
					version: "1.7",
					environmentKey: "sympy-1.7",
					baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
					sandboxTemplate: "dapr-agent",
					sandboxImage:
						"ghcr.io/pittampalliorg/swebench-inference-sympy-1.7:env-abc",
					digest:
						"sha256:1111111111111111111111111111111111111111111111111111111111111111",
					validationStatus: "validated",
					buildStrategy: "swebench-harness",
					workspaceRoot: "/testbed",
					condaEnvironment: "testbed",
					envSpecHash: exactSpec.envSpecHash,
				},
			]),
		);
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_FILE", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_DIR", "");

		const result = await ensureSwebenchEnvironment({
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			allowBuild: true,
			forceRefreshLegacyStatic: true,
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
			},
		});

		expect(result).toMatchObject({
			success: true,
			status: "validated",
			source: "static_mapping",
			environmentKey: "sympy-1.7",
		});
		expect(tektonMocks.createTektonPipelineRun).not.toHaveBeenCalled();
		expect(dbMocks.insertValues).not.toHaveBeenCalled();
	});

	it("bypasses legacy static SWE-bench mappings when refresh is requested", async () => {
		vi.stubEnv(
			"SWEBENCH_INFERENCE_ENVIRONMENTS_JSON",
			JSON.stringify([
				{
					suite: "SWE-bench_Verified",
					repo: "sympy/sympy",
					version: "1.7",
					environmentKey: "sympy-1.7",
					baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
					sandboxTemplate: "dapr-agent",
					sandboxImage:
						"ghcr.io/pittampalliorg/swebench-inference-sympy-1.7:legacy",
					digest:
						"sha256:2222222222222222222222222222222222222222222222222222222222222222",
					validationStatus: "validated",
				},
			]),
		);
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_FILE", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_DIR", "");
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE", "local");

		const result = await ensureSwebenchEnvironment({
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			allowBuild: true,
			forceRefreshLegacyStatic: true,
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
			},
		});

		expect(result).toMatchObject({
			success: false,
			status: "failed",
			reason: "dynamic_build_local_target_not_allowed",
			environmentKey: "sympy-1.7",
		});
		expect(tektonMocks.createTektonPipelineRun).not.toHaveBeenCalled();
		expect(dbMocks.insertValues).not.toHaveBeenCalled();
	});

	it("bypasses non-exact static SWE-bench mappings when refresh is requested", async () => {
		vi.stubEnv(
			"SWEBENCH_INFERENCE_ENVIRONMENTS_JSON",
			JSON.stringify([
				{
					suite: "SWE-bench_Verified",
					repo: "sympy/sympy",
					version: "1.7",
					environmentKey: "sympy-1.7",
					baseCommit: "different-base-commit",
					sandboxTemplate: "dapr-agent",
					sandboxImage:
						"ghcr.io/pittampalliorg/swebench-inference-sympy-1.7:env-abc",
					digest:
						"sha256:3333333333333333333333333333333333333333333333333333333333333333",
					validationStatus: "validated",
					buildStrategy: "swebench-harness",
					workspaceRoot: "/testbed",
					condaEnvironment: "testbed",
					envSpecHash: "b".repeat(64),
				},
			]),
		);
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_FILE", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_DIR", "");
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE", "local");

		const result = await ensureSwebenchEnvironment({
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			allowBuild: true,
			forceRefreshLegacyStatic: true,
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
			},
		});

		expect(result).toMatchObject({
			success: false,
			status: "failed",
			reason: "dynamic_build_local_target_not_allowed",
			environmentKey: "sympy-1.7",
		});
		expect(tektonMocks.createTektonPipelineRun).not.toHaveBeenCalled();
		expect(dbMocks.insertValues).not.toHaveBeenCalled();
	});

	it("refuses local SWE-bench image PipelineRuns unless local submission is explicitly enabled", async () => {
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_JSON", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_FILE", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_DIR", "");
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE", "local");

		const result = await ensureSwebenchEnvironment({
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			allowBuild: true,
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
			},
		});

		expect(result).toMatchObject({
			success: false,
			complete: true,
			status: "failed",
			reason: "dynamic_build_local_target_not_allowed",
		});
		expect(tektonMocks.createTektonPipelineRun).not.toHaveBeenCalled();
		expect(dbMocks.insertValues).not.toHaveBeenCalled();
	});

	it("refuses hub SWE-bench image PipelineRuns without a hub kubeconfig", async () => {
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_JSON", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_FILE", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_DIR", "");
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE", "hub");

		const result = await ensureSwebenchEnvironment({
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			allowBuild: true,
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
			},
		});

		expect(result).toMatchObject({
			success: false,
			complete: true,
			status: "failed",
			reason: "dynamic_build_hub_target_not_configured",
		});
		expect(tektonMocks.createTektonPipelineRun).not.toHaveBeenCalled();
		expect(dbMocks.insertValues).not.toHaveBeenCalled();
	});

	it("throttles hub SWE-bench image PipelineRun submission when active build cap is reached", async () => {
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_JSON", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_FILE", "");
		vi.stubEnv("SWEBENCH_INFERENCE_ENVIRONMENTS_DIR", "");
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_SUBMISSION_MODE", "hub");
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_HUB_KUBECONFIG", "/tmp/hub-kubeconfig");
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_MAX_ACTIVE", "1");
		dbMocks.selectLimit
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ id: "active-build" }]);

		const result = await ensureSwebenchEnvironment({
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			allowBuild: true,
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
			},
		});

		expect(result).toMatchObject({
			success: false,
			complete: true,
			status: "failed",
			reason: "dynamic_build_capacity_exhausted",
		});
		expect(tektonMocks.createTektonPipelineRun).not.toHaveBeenCalled();
		expect(dbMocks.insertValues).not.toHaveBeenCalled();
	});

	it("pins generated SWE-bench image PipelineRuns to hub build nodes", () => {
		const spec = buildSwebenchEnvironmentSpec({
			dataset: "princeton-nlp/SWE-bench_Verified",
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
			},
		});

		const manifest = buildSwebenchPipelineRunManifest(
			spec,
			"swe-env-test",
			"tekton-pipelines",
		);
		const runSpec = manifest.spec as Record<string, unknown>;

		expect(runSpec.timeouts).toEqual({
			pipeline: "6h0m0s",
			tasks: "5h45m0s",
			finally: "15m0s",
		});
		expect(runSpec.taskRunTemplate).toMatchObject({
			serviceAccountName: "workflow-builder-build-trigger",
			podTemplate: {
				nodeSelector: { "stacks.io/build-pool": "hub" },
				tolerations: [
					{
						key: "stacks.io/build-pool",
						operator: "Equal",
						value: "hub",
						effect: "NoSchedule",
					},
				],
			},
		});
		expect(runSpec.params).toEqual(
			expect.arrayContaining([
				{
					name: "git_url",
					value: "https://github.com/PittampalliOrg/workflow-builder.git",
				},
				{
					name: "stacks_repo",
					value: "https://github.com/PittampalliOrg/stacks.git",
				},
			]),
		);
		expect(manifest.metadata?.labels).toMatchObject({
			"workflow-builder.cnoe.io/build-cache": "buildah-cache-swebench-inference",
		});
		expect(runSpec.workspaces).toEqual(
			expect.arrayContaining([
				{
					name: "buildah-cache",
					persistentVolumeClaim: {
						claimName: "buildah-cache-swebench-inference",
					},
				},
			]),
		);
	});

	it("shards SWE-bench PipelineRun Buildah caches when configured", () => {
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_CACHE_SHARDS", "3");
		const spec = buildSwebenchEnvironmentSpec({
			dataset: "princeton-nlp/SWE-bench_Verified",
			suiteSlug: "SWE-bench_Verified",
			instanceId: "django__django-10554",
			repo: "django/django",
			baseCommit: "08ecf3f6a13900c80ba7143db2f00898b783510e",
			testMetadata: {
				version: "2.2",
				test_patch: "diff --git a/tests/test_fix.py b/tests/test_fix.py\n",
				FAIL_TO_PASS: ["tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["tests/test_existing.py::test_existing"],
			},
		});
		const shard =
			createHash("sha256").update(spec.envSpecHash).digest().readUInt32BE(0) % 3;
		const claimName = `buildah-cache-swebench-inference-${shard}`;

		const manifest = buildSwebenchPipelineRunManifest(
			spec,
			"swe-env-test",
			"tekton-pipelines",
		);
		const runSpec = manifest.spec as Record<string, unknown>;

		expect(manifest.metadata?.labels).toMatchObject({
			"workflow-builder.cnoe.io/build-cache": claimName,
		});
		expect(runSpec.workspaces).toEqual(
			expect.arrayContaining([
				{
					name: "buildah-cache",
					persistentVolumeClaim: { claimName },
				},
			]),
		);
	});

	it("pins sharded SWE-bench PipelineRuns to configured cache nodes", () => {
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_CACHE_SHARDS", "3");
		vi.stubEnv(
			"SWEBENCH_INFERENCE_BUILD_CACHE_SHARD_NODES",
			"hub-build-1,hub-build-2,hub-build-2",
		);
		const spec = buildSwebenchEnvironmentSpec({
			dataset: "princeton-nlp/SWE-bench_Verified",
			suiteSlug: "SWE-bench_Verified",
			instanceId: "django__django-10554",
			repo: "django/django",
			baseCommit: "08ecf3f6a13900c80ba7143db2f00898b783510e",
			testMetadata: {
				version: "2.2",
				test_patch: "diff --git a/tests/test_fix.py b/tests/test_fix.py\n",
				FAIL_TO_PASS: ["tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["tests/test_existing.py::test_existing"],
			},
		});
		const shard =
			createHash("sha256").update(spec.envSpecHash).digest().readUInt32BE(0) % 3;
		const expectedNode = ["hub-build-1", "hub-build-2", "hub-build-2"][shard];

		const manifest = buildSwebenchPipelineRunManifest(
			spec,
			"swe-env-test",
			"tekton-pipelines",
		);
		const runSpec = manifest.spec as Record<string, unknown>;

		expect(runSpec.taskRunTemplate).toMatchObject({
			podTemplate: {
				nodeSelector: {
					"stacks.io/build-pool": "hub",
					"kubernetes.io/hostname": expectedNode,
				},
			},
		});
	});

	it("pins the one-shard SWE-bench PipelineRun when a cache node is configured", () => {
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_CACHE_SHARDS", "1");
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_CACHE_SHARD_NODES", "hub-build-1");
		const spec = buildSwebenchEnvironmentSpec({
			dataset: "princeton-nlp/SWE-bench_Verified",
			suiteSlug: "SWE-bench_Verified",
			instanceId: "django__django-10554",
			repo: "django/django",
			baseCommit: "08ecf3f6a13900c80ba7143db2f00898b783510e",
			testMetadata: {
				version: "2.2",
				test_patch: "diff --git a/tests/test_fix.py b/tests/test_fix.py\n",
				FAIL_TO_PASS: ["tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["tests/test_existing.py::test_existing"],
			},
		});

		const manifest = buildSwebenchPipelineRunManifest(
			spec,
			"swe-env-test",
			"tekton-pipelines",
		);
		const runSpec = manifest.spec as Record<string, unknown>;

		expect(manifest.metadata?.labels).toMatchObject({
			"workflow-builder.cnoe.io/build-cache": "buildah-cache-swebench-inference",
		});
		expect(runSpec.taskRunTemplate).toMatchObject({
			podTemplate: {
				nodeSelector: {
					"stacks.io/build-pool": "hub",
					"kubernetes.io/hostname": "hub-build-1",
				},
			},
		});
	});

	it("keeps the preferred SWE-bench cache shard when it is not busier than alternatives", () => {
		const envSpecHash = "abc123";
		const preferred =
			createHash("sha256").update(envSpecHash).digest().readUInt32BE(0) % 3;

		expect(
			selectSwebenchBuildahCacheShard({
				envSpecHash,
				shards: 3,
				activeShardCounts: { [(preferred + 1) % 3]: 1 },
			}),
		).toBe(preferred);
	});

	it("moves a SWE-bench cache shard selection away from an active shard collision", () => {
		const envSpecHash = "abc123";
		const preferred =
			createHash("sha256").update(envSpecHash).digest().readUInt32BE(0) % 3;
		const expected = [0, 1, 2].find((shard) => shard !== preferred);

		expect(
			selectSwebenchBuildahCacheShard({
				envSpecHash,
				shards: 3,
				activeShardCounts: { [preferred]: 1 },
			}),
		).toBe(expected);
	});

	it("can label SWE-bench PipelineRuns for Kueue-managed hub build capacity", () => {
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_KUEUE_QUEUE_NAME", "swebench-image-builds");
		const spec = buildSwebenchEnvironmentSpec({
			dataset: "princeton-nlp/SWE-bench_Verified",
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
			},
		});

		const manifest = buildSwebenchPipelineRunManifest(
			spec,
			"swe-env-test",
			"tekton-pipelines",
		);

		expect(manifest.metadata?.labels).toMatchObject({
			"kueue.x-k8s.io/queue-name": "swebench-image-builds",
		});
	});

	it("builds a wrapping PipelineRun for a digest-pinned prebuilt Epoch image", () => {
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_CACHE_SHARDS", "3");
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_KUEUE_QUEUE_NAME", "swebench-image-builds");
		const spec = buildSwebenchEnvironmentSpec({
			dataset: "princeton-nlp/SWE-bench_Verified",
			suiteSlug: "SWE-bench_Verified",
			instanceId: "django__django-14351",
			repo: "django/django",
			baseCommit: "abc123",
			testMetadata: {
				version: "4.0",
				test_patch: "diff --git a/tests/test_fix.py b/tests/test_fix.py\n",
				FAIL_TO_PASS: ["tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["tests/test_existing.py::test_existing"],
			},
		});

		const manifest = buildSwebenchPrebuiltPipelineRunManifest(
			spec,
			{
				source: "epoch-research-ghcr",
				imageRef:
					"ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-14351:latest",
				digest: "sha256:a9df",
				sandboxImage:
					"ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-14351:latest@sha256:a9df",
				manifestMediaType: "application/vnd.docker.distribution.manifest.v2+json",
				configMediaType: "application/vnd.docker.container.image.v1+json",
				created: "2024-10-31T00:49:31Z",
				labels: {
					"swe-bench.instance_id": "django__django-14351",
					"swe-bench.repo": "django/django",
				},
			},
			"swe-env-test",
			"tekton-pipelines",
			{
				buildahCache: {
					claimName: "buildah-cache-swebench-inference-2",
					shard: 2,
					nodeName: "hub-build-1",
				},
			},
		);
		const runSpec = manifest.spec as Record<string, unknown>;

		expect((runSpec.pipelineRef as Record<string, unknown>).name).toBe(
			"swebench-inference-image-import",
		);
		expect(manifest.metadata?.labels).toMatchObject({
			"workflow-builder.cnoe.io/build-backend": "prebuilt-epoch",
			"workflow-builder.cnoe.io/build-cache": "buildah-cache-swebench-inference-2",
			"kueue.x-k8s.io/queue-name": "swebench-image-builds",
		});
		expect(runSpec.taskRunTemplate).toMatchObject({
			podTemplate: {
				nodeSelector: {
					"stacks.io/build-pool": "hub",
					"kubernetes.io/hostname": "hub-build-1",
				},
			},
		});
		expect(runSpec.params).toEqual(
			expect.arrayContaining([
				{
					name: "image_ref",
					value:
						"ghcr.io/epoch-research/swe-bench.eval.x86_64.django__django-14351:latest",
				},
				{ name: "image_digest", value: "sha256:a9df" },
				{ name: "image_name", value: spec.imageName },
				{ name: "image_tag", value: spec.imageTag },
				{ name: "env_spec_hash", value: spec.envSpecHash },
			]),
		);
		const metadataParam = (runSpec.params as Array<{ name: string; value: string }>).find(
			(param) => param.name === "swebench_spec_metadata",
		);
		expect(metadataParam?.value).toContain('"source":"epoch-research-ghcr"');
		expect(metadataParam?.value).toContain(`"envSpecHash":"${spec.envSpecHash}"`);
	});

	it("routes per-instance buildBackend=nix to the Nix Pipeline with no PVC and no hostname pin", () => {
		const spec = buildSwebenchEnvironmentSpec({
			dataset: "princeton-nlp/SWE-bench_Verified",
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			buildBackend: "nix",
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
			},
		});

		expect(spec.buildBackend).toBe("nix");
		expect(spec.imageTag.endsWith("-nix")).toBe(true);

		const manifest = buildSwebenchPipelineRunManifest(
			spec,
			"swe-env-test",
			"tekton-pipelines",
		);
		const runSpec = manifest.spec as Record<string, unknown>;

		expect((runSpec.pipelineRef as Record<string, unknown>).name).toBe(
			"swebench-inference-image-build-nix",
		);
		expect(manifest.metadata?.labels).toMatchObject({
			"workflow-builder.cnoe.io/build-backend": "nix",
			"workflow-builder.cnoe.io/build-cache": "cachix:pittampalliorg",
		});
		expect(runSpec.taskRunTemplate).toMatchObject({
			podTemplate: { nodeSelector: { "stacks.io/build-pool": "hub" } },
		});
		expect(
			(runSpec.taskRunTemplate as { podTemplate: { nodeSelector: Record<string, string> } })
				.podTemplate.nodeSelector["kubernetes.io/hostname"],
		).toBeUndefined();
		expect(runSpec.workspaces).toEqual(
			expect.arrayContaining([{ name: "buildah-cache", emptyDir: {} }]),
		);
		expect(runSpec.params).toEqual(
			expect.arrayContaining([{ name: "cachix_cache", value: "pittampalliorg" }]),
		);
	});

	it("falls back to buildah for buildpacks strategy even when nix backend is requested", () => {
		const spec = buildSwebenchEnvironmentSpec({
			suiteSlug: "SWE-bench_Lite",
			instanceId: "unknown__repo-1",
			repo: "unknown/repo",
			baseCommit: "abcdef0123456789",
			buildBackend: "nix",
			testMetadata: {},
		});

		expect(spec.buildStrategy).toBe("buildpacks");
		expect(spec.buildBackend).toBe("buildah");
		expect(spec.imageTag.endsWith("-nix")).toBe(false);

		const manifest = buildSwebenchPipelineRunManifest(
			spec,
			"swe-env-test",
			"tekton-pipelines",
		);
		const runSpec = manifest.spec as Record<string, unknown>;
		expect((runSpec.pipelineRef as Record<string, unknown>).name).toBe(
			"swebench-inference-image-build",
		);
	});

	it("honors SWEBENCH_INFERENCE_BUILD_BACKEND=nix env var when no per-instance override is set", () => {
		vi.stubEnv("SWEBENCH_INFERENCE_BUILD_BACKEND", "nix");
		const spec = buildSwebenchEnvironmentSpec({
			suiteSlug: "SWE-bench_Verified",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
			},
		});
		expect(spec.buildBackend).toBe("nix");
	});

	it("uses repo-aware validation defaults for Flask source-layout images", () => {
		const spec = buildSwebenchEnvironmentSpec({
			suiteSlug: "SWE-bench_Lite",
			instanceId: "pallets__flask-4992",
			repo: "pallets/flask",
			baseCommit: "4c288bc97ea371817199908d0d9b12de9dae327e",
			testMetadata: {
				version: "2.3",
				test_patch: "diff --git a/tests/test_appctx.py b/tests/test_appctx.py\n",
			},
		});

		expect(spec).toMatchObject({
			environmentKey: "flask-2.3",
			dockerfilePath: "Dockerfile",
			validationCommand: expect.stringContaining("/sandbox/repo"),
		});
		expect(spec.environmentNotes).toContain(
			"For local imports and tests in this source-layout repo, prefix Python commands with PYTHONPATH=src.",
		);
	});

	it("carries Xarray harness metadata instead of choosing latest buildpack packages", () => {
		const spec = buildSwebenchEnvironmentSpec({
			suiteSlug: "SWE-bench_Lite",
			instanceId: "pydata__xarray-3993",
			repo: "pydata/xarray",
			baseCommit: "abc123",
			testMetadata: {
				version: "2024.05",
				test_patch: "diff --git a/xarray/tests/test_dataset.py b/xarray/tests/test_dataset.py\n",
				FAIL_TO_PASS: ["xarray/tests/test_dataset.py::test_regression"],
				PASS_TO_PASS: ["xarray/tests/test_dataset.py::test_existing"],
			},
		});

		expect(spec.buildStrategy).toBe("swebench-harness");
		expect(spec.swebenchSpecInput).toMatchObject({
			repo: "pydata/xarray",
			version: "2024.05",
			FAIL_TO_PASS: ["xarray/tests/test_dataset.py::test_regression"],
		});
		expect(spec.environmentNotes.join("\n")).toContain("SWE-bench harness spec");
	});

	it("normalizes PipelineRun and TaskRun status into deterministic activity events", () => {
		const build = mockBuild();
		const events = normalizeEnvironmentBuildActivityEvents({
			build,
			pipelineRun: {
				metadata: {
					name: "swe-env-abc",
					namespace: "tekton-pipelines",
					creationTimestamp: "2026-04-28T12:00:01.000Z",
				},
				status: {
					startTime: "2026-04-28T12:00:02.000Z",
					completionTime: "2026-04-28T12:05:00.000Z",
					conditions: [
						{
							type: "Succeeded",
							status: "True",
							reason: "Succeeded",
							message: "pipeline completed",
							lastTransitionTime: "2026-04-28T12:05:00.000Z",
						},
					],
					results: [
						{ name: "image_ref", value: "registry/swebench:env-abc" },
						{ name: "image_digest", value: "sha256:111" },
						{ name: "validation_status", value: "validated" },
						{ name: "validation_log_ref", value: "tekton://taskruns/validate-image" },
						{ name: "built_at", value: "2026-04-28T12:05:00Z" },
					],
				},
			},
			taskRuns: [
				{
					metadata: {
						name: "swe-env-abc-validate-image",
						namespace: "tekton-pipelines",
						labels: {
							"tekton.dev/pipelineRun": "swe-env-abc",
							"tekton.dev/pipelineTask": "validate-image",
						},
					},
					status: {
						startTime: "2026-04-28T12:03:00.000Z",
						completionTime: "2026-04-28T12:04:00.000Z",
						conditions: [
							{
								type: "Succeeded",
								status: "True",
								reason: "Succeeded",
								lastTransitionTime: "2026-04-28T12:04:00.000Z",
							},
						],
					},
				},
			],
		});

		expect(events[0]?.eventType).toBe("build_queued");
		expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining([
			"build_queued",
			"pipelinerun_created",
			"task_started",
			"validation_started",
			"task_succeeded",
			"validation_succeeded",
			"validation_succeeded",
			"image_pushed",
			"digest_captured",
			"build_succeeded",
		]));
		expect(events.find((event) => event.eventType === "image_pushed")?.message).toBe(
			"registry/swebench:env-abc",
		);

		const repeated = normalizeEnvironmentBuildActivityEvents({
			build,
			pipelineRun: {
				metadata: { name: "swe-env-abc", namespace: "tekton-pipelines" },
				status: {
					completionTime: "2026-04-28T12:05:00.000Z",
					conditions: [{ type: "Succeeded", status: "True" }],
					results: [{ name: "image_digest", value: "sha256:111" }],
				},
			},
		});
		expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
		expect(
			repeated.find((event) => event.eventType === "digest_captured")?.id,
		).toBe(events.find((event) => event.eventType === "digest_captured")?.id);
	});

	it("keeps the queued event id stable after a PipelineRun is attached", () => {
		const queued = normalizeEnvironmentBuildActivityEvents({
			build: mockBuild({
				status: "queued",
				pipelineRunName: null,
				pipelineRunNamespace: null,
				startedAt: null,
			}),
		});
		const building = normalizeEnvironmentBuildActivityEvents({
			build: mockBuild({
				status: "building",
				pipelineRunName: "swe-env-abc",
				pipelineRunNamespace: "tekton-pipelines",
			}),
			pipelineRun: {
				metadata: { name: "swe-env-abc", namespace: "tekton-pipelines" },
			},
		});

		const queuedEvent = queued.find((event) => event.eventType === "build_queued");
		const buildingQueuedEvent = building.find(
			(event) => event.eventType === "build_queued",
		);
		expect(buildingQueuedEvent?.id).toBe(queuedEvent?.id);
		expect(buildingQueuedEvent?.pipelineRunName).toBeNull();
	});

	it("keeps the PipelineRun-created event id stable when Tekton metadata is later hydrated", () => {
		const initial = normalizeEnvironmentBuildActivityEvents({
			build: mockBuild({
				startedAt: new Date("2026-04-28T12:00:01.123Z"),
			}),
			pipelineRun: {
				metadata: { name: "swe-env-abc", namespace: "tekton-pipelines" },
			},
		});
		const hydrated = normalizeEnvironmentBuildActivityEvents({
			build: mockBuild({
				startedAt: new Date("2026-04-28T12:00:01.123Z"),
			}),
			pipelineRun: {
				metadata: {
					name: "swe-env-abc",
					namespace: "tekton-pipelines",
					creationTimestamp: "2026-04-28T12:00:01.000Z",
				},
			},
		});

		const initialEvent = initial.find(
			(event) => event.eventType === "pipelinerun_created",
		);
		const hydratedEvent = hydrated.find(
			(event) => event.eventType === "pipelinerun_created",
		);
		expect(hydratedEvent?.id).toBe(initialEvent?.id);
	});

	it("captures failed validation task details", () => {
		const events = normalizeEnvironmentBuildActivityEvents({
			build: mockBuild({ status: "building" }),
			taskRuns: [
				{
					metadata: {
						name: "swe-env-abc-validate-image",
						labels: { "tekton.dev/pipelineTask": "validate-image" },
					},
					status: {
						startTime: "2026-04-28T12:03:00.000Z",
						completionTime: "2026-04-28T12:04:00.000Z",
						conditions: [
							{
								type: "Succeeded",
								status: "False",
								reason: "Failed",
								message: "pytest import smoke test failed",
								lastTransitionTime: "2026-04-28T12:04:00.000Z",
							},
						],
					},
				},
			],
		});

		const failed = events.find((event) => event.eventType === "validation_failed");
		expect(failed).toMatchObject({
			taskRunName: "swe-env-abc-validate-image",
			phase: "validate-image",
			reason: "Failed",
			message: "pytest import smoke test failed",
		});
	});

	it("does not treat stale validated fields as usable for pipeline-managed builds", () => {
		expect(
			hasUsableValidatedImage({
				validationStatus: "validated",
				sandboxImage:
					"ghcr.io/pittampalliorg/swebench-inference-matplotlib-3.5:env-abc@sha256:41ec9d82c6389366facd5576a790bc5937fdfdd1e7fcb1dad8904c76e2719679",
				digest: null,
			}),
		).toBe(true);
		expect(
			hasUsableValidatedImage({
				validationStatus: "validated",
				sandboxImage:
					"ghcr.io/pittampalliorg/swebench-inference-matplotlib-3.5:env-abc@sha256:41ec9d82c6389366facd5576a790bc5937fdfdd1e7fcb1dad8904c76e2719679",
				digest: null,
				pipelineRunName: "swe-env-failed",
			}),
		).toBe(false);
		expect(
			hasUsableValidatedImage({
				validationStatus: "failed",
				sandboxImage:
					"ghcr.io/pittampalliorg/swebench-inference-matplotlib-3.5:env-abc@sha256:41ec9d82c6389366facd5576a790bc5937fdfdd1e7fcb1dad8904c76e2719679",
				digest: null,
			}),
		).toBe(false);
	});

	it("marks a pipeline-managed terminal row failed when the owning PipelineRun failed", async () => {
		const build = mockBuild({
			status: "validated",
			validationStatus: "validated",
			validationLogRef: "tekton://taskruns/swe-env-failed-validate-image",
			sandboxImage: "registry/swebench:env-abc@sha256:111",
			digest: "sha256:111",
			builtAt: new Date("2026-04-28T12:05:00.000Z"),
			pipelineRunName: "swe-env-failed",
		});
		const failedUpdate = {
			...(build as Record<string, unknown>),
			status: "failed",
			validationStatus: "failed",
			validationLogRef: null,
			builtAt: null,
			error: "Tasks Completed: 2 (Failed: 1, Cancelled 0), Skipped: 1",
		};
		dbMocks.updateReturning.mockResolvedValue([failedUpdate]);
		tektonMocks.getTektonPipelineRun.mockResolvedValue({
			metadata: { name: "swe-env-failed", namespace: "tekton-pipelines" },
			status: {
				completionTime: "2026-04-28T12:10:00.000Z",
				conditions: [
					{
						type: "Succeeded",
						status: "False",
						reason: "Failed",
						message: "Tasks Completed: 2 (Failed: 1, Cancelled 0), Skipped: 1",
					},
				],
			},
		});

		const synced = await syncEnvironmentBuild(build);

		expect(tektonMocks.getTektonPipelineRun).toHaveBeenCalledWith(
			"tekton-pipelines",
			"swe-env-failed",
			{ targetCluster: "local" },
		);
		expect(dbMocks.updateSet).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "failed",
				validationStatus: "failed",
				validationLogRef: null,
				builtAt: null,
				error: "Tasks Completed: 2 (Failed: 1, Cancelled 0), Skipped: 1",
			}),
		);
		expect(synced).toMatchObject({
			status: "failed",
			validationStatus: "failed",
			validationLogRef: null,
			builtAt: null,
		});
	});
});

function mockBuild(overrides: Record<string, unknown> = {}) {
	const now = new Date("2026-04-28T12:00:00.000Z");
	return {
		id: "build_1",
		dataset: "SWE-bench/SWE-bench_Lite",
		suite: "SWE-bench_Lite",
		repo: "sympy/sympy",
		version: "1.7",
		environmentSetupCommit: null,
		baseCommit: "abc123",
		environmentKey: "sympy-1.7",
		envSpecHash: "a".repeat(64),
		buildStrategy: "swebench-harness",
		status: "building",
		sandboxTemplate: "dapr-agent",
		sandboxImage: null,
		digest: null,
		imageName: "swebench-inference-sympy-1.7",
		imageTag: "env-abc",
		dockerfilePath: "Dockerfile",
		validationCommand: "python -m pytest --version",
		validationStatus: null,
		validationLogRef: null,
		buildLogRef: null,
		pipelineRunName: "swe-env-abc",
		pipelineRunNamespace: "tekton-pipelines",
		spec: {},
		metadata: {},
		error: null,
		requestedAt: now,
		startedAt: now,
		completedAt: null,
		builtAt: null,
		createdAt: now,
		updatedAt: now,
		...overrides,
	} as never;
}

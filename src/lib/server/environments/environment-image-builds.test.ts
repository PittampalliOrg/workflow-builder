import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildSwebenchEnvironmentSpec,
	normalizeEnvironmentBuildActivityEvents,
	plannedSwebenchInferenceEnvironment,
} from "./environment-image-builds";

describe("SWE-bench environment image build planning", () => {
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
			workspaceRoot: "/testbed",
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
			workspaceRoot: "/testbed",
			condaEnvironment: "testbed",
		});
		expect(planned).toHaveProperty("envSpecHash");
		expect(planned).not.toHaveProperty("sandboxImage");
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
			validationCommand: expect.stringContaining("/testbed"),
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

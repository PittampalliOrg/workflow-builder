import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildSwebenchEnvironmentSpec,
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
			dockerfilePath:
				"services/openshell-sandbox/environments/Dockerfile.swebench-inference-sympy-1.7",
			validationCommand: "PYTHONPATH=src python -m pytest --version",
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
			testMetadata: { version: "3.2" },
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
		});
		expect(planned).toHaveProperty("envSpecHash");
		expect(planned).not.toHaveProperty("sandboxImage");
	});
});

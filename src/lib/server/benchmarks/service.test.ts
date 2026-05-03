import { afterEach, describe, expect, it, vi } from "vitest";
import {
	benchmarkInferenceStallState,
	benchmarkAgentRuntimeCleanupInstanceIds,
	benchmarkRunInstanceTerminalPatch,
	buildSwebenchInstanceWorkflowGraph,
	buildSwebenchInstanceWorkflowSpec,
	collectBenchmarkTraceIds,
	effectiveBenchmarkConcurrency,
	extractAgentStopReason,
	extractBenchmarkRuntimeLinks,
	extractInferenceEnvironment,
	isBenignDaprTerminationMiss,
	resolveBenchmarkInferenceStatus,
	resolveBenchmarkInstanceStatusAfterInference,
	sanitizeSwebenchInferenceEnvironmentForRuntime,
	shouldFinalizeBenchmarkLifecycle,
} from "./service";
import {
	buildSwebenchDatasetJsonl,
	findMissingSwebenchMetadata,
	isCompleteSwebenchInstanceMetadata,
} from "./swebench";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("SWE-bench DB metadata", () => {
	it("detects missing or incomplete imported instance metadata", () => {
		const rows = [
			{
				instanceId: "sympy__sympy-20590",
				repo: "sympy/sympy",
				baseCommit: "abc123",
				problemStatement: "Fix it",
			},
			{
				instanceId: "psf__requests-2317",
				repo: "psf/requests",
				baseCommit: null,
				problemStatement: "Fix it",
			},
		];

		expect(isCompleteSwebenchInstanceMetadata(rows[0])).toBe(true);
		expect(isCompleteSwebenchInstanceMetadata(rows[1])).toBe(false);
		expect(
			findMissingSwebenchMetadata(
				[
					"sympy__sympy-20590",
					"psf__requests-2317",
					"django__django-11099",
				],
				rows,
			),
		).toEqual(["psf__requests-2317", "django__django-11099"]);
	});

	it("exports DB rows as SWE-bench-compatible dataset JSONL", () => {
		const jsonl = buildSwebenchDatasetJsonl([
			{
				instanceId: "sympy__sympy-20590",
				repo: "sympy/sympy",
				baseCommit: "abc123",
				problemStatement: "Fix it",
				hintsText: null,
				goldPatch: "diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
				testMetadata: {
					test_patch: "diff --git a/sympy/core/tests/test_add.py b/sympy/core/tests/test_add.py\n",
					FAIL_TO_PASS: ["sympy/core/tests/test_add.py::test_regression"],
					PASS_TO_PASS: ["sympy/core/tests/test_add.py::test_existing"],
					version: "1.7",
				},
				metadata: {
					created_at: "2021-01-01T00:00:00Z",
					environment_setup_commit: "env123",
				},
			},
		]);

		const [record] = jsonl
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(record).toMatchObject({
			instance_id: "sympy__sympy-20590",
			repo: "sympy/sympy",
			base_commit: "abc123",
			problem_statement: "Fix it",
			hints_text: "",
			patch: "diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
			test_patch: "diff --git a/sympy/core/tests/test_add.py b/sympy/core/tests/test_add.py\n",
			version: "1.7",
			environment_setup_commit: "env123",
		});
		expect(record.FAIL_TO_PASS).toEqual([
			"sympy/core/tests/test_add.py::test_regression",
		]);
		expect(record.PASS_TO_PASS).toEqual([
			"sympy/core/tests/test_add.py::test_existing",
		]);
		expect(jsonl.endsWith("\n")).toBe(true);
	});
});

describe("SWE-bench workflow spec", () => {
	it("caps stored benchmark concurrency to the selected instance count", () => {
		vi.stubEnv("BENCHMARK_DEFAULT_CONCURRENCY", "5");
		vi.stubEnv("BENCHMARK_MAX_ACTIVE_INFERENCE_INSTANCES", "10");
		vi.stubEnv(
			"AGENT_RUNTIME_SLOTS_PER_REPLICA_JSON",
			JSON.stringify({ coding: 5, office: 2, browser: 1, testing: 2 }),
		);
		expect(
			effectiveBenchmarkConcurrency({
				instanceCount: 3,
				concurrency: 32,
				evaluationConcurrency: 128,
			}),
		).toEqual({ concurrency: 3, evaluationConcurrency: 3 });
		expect(
			effectiveBenchmarkConcurrency({
				instanceCount: 100,
				concurrency: 0,
				evaluationConcurrency: undefined,
			}),
		).toEqual({ concurrency: 5, evaluationConcurrency: 5 });
		expect(
			effectiveBenchmarkConcurrency({
				instanceCount: 25,
				concurrency: 25,
				runtimeClass: "coding",
				runtimeIsolation: "shared",
				runtimeAppId: "agent-runtime-pool-coding",
				poolMaxReplicas: 2,
			}).concurrency,
		).toBe(10);
	});

	it("detects inferencing stalls from session/event progress", () => {
		const now = new Date("2026-05-02T12:10:00Z");
		expect(
			benchmarkInferenceStallState({
				now,
				stallSeconds: 480,
				startedAt: new Date("2026-05-02T12:00:00Z"),
				sessionUpdatedAt: new Date("2026-05-02T12:01:00Z"),
				latestEventCreatedAt: new Date("2026-05-02T12:01:30Z"),
			}),
		).toMatchObject({
			stalled: true,
			stalledSeconds: 510,
		});
		expect(
			benchmarkInferenceStallState({
				now,
				stallSeconds: 480,
				startedAt: new Date("2026-05-02T12:00:00Z"),
				latestEventCreatedAt: new Date("2026-05-02T12:06:00Z"),
			}).stalled,
		).toBe(false);

		const recentBenchmarkRowTouch = {
			now,
			stallSeconds: 480,
			startedAt: new Date("2026-05-02T12:00:00Z"),
			sessionUpdatedAt: new Date("2026-05-02T12:01:00Z"),
			latestEventCreatedAt: new Date("2026-05-02T12:01:30Z"),
			rowUpdatedAt: new Date("2026-05-02T12:09:59Z"),
		} as Parameters<typeof benchmarkInferenceStallState>[0] & { rowUpdatedAt: Date };
		expect(benchmarkInferenceStallState(recentBenchmarkRowTouch).stalled).toBe(true);
	});

	it("finalizes lifecycle aggregation after inference leaves active states", () => {
		expect(
			shouldFinalizeBenchmarkLifecycle({
				status: "inferencing",
				inferenceStatus: "inferencing",
			}),
		).toBe(false);
		expect(
			shouldFinalizeBenchmarkLifecycle({
				status: "inferred",
				inferenceStatus: "inferred",
			}),
		).toBe(true);
		expect(
			shouldFinalizeBenchmarkLifecycle({
				status: "timeout",
				inferenceStatus: "timeout",
			}),
		).toBe(true);
	});

	it("builds a canvas graph for generated SWE-bench instance runs", () => {
		const graph = buildSwebenchInstanceWorkflowGraph();
		const nodes = graph.nodes as Array<{ id: string; type: string }>;
		const edges = graph.edges as Array<{ source: string; target: string }>;
		expect(nodes.map((node) => node.id)).toEqual([
			"__start__",
			"prepare_environment",
			"workspace_profile",
			"checkout_repo",
			"solve",
			"extract_patch",
			"__end__",
		]);
		expect(nodes.find((node) => node.id === "solve")?.type).toBe("agent");
		expect(edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
			"__start__->prepare_environment",
			"prepare_environment->workspace_profile",
			"workspace_profile->checkout_repo",
			"checkout_repo->solve",
			"solve->extract_patch",
			"extract_patch->__end__",
		]);
	});

	it("uses a POSIX-compatible checkout command", () => {
		const spec = buildSwebenchInstanceWorkflowSpec({
			runId: "run_1",
			suiteSlug: "SWE-bench_Lite",
			datasetName: "princeton-nlp/SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "abc123",
			problemStatement: "Fix it",
			hintsText: null,
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
			},
			agentId: "agent_1",
			agentVersion: 1,
			timeoutSeconds: 7200,
			maxTurns: null,
		});

		const steps = spec.do as Array<Record<string, { with: Record<string, unknown> }>>;
		const workspaceProfile = steps[1].workspace_profile;
		const checkoutStep = steps[2].checkout_repo;
		expect(workspaceProfile.with.sandboxImage).toBe(
			"${ .prepare_environment.sandboxImage }",
		);
		expect(String(checkoutStep.with.command)).toContain("set -eu\n");
		expect(String(checkoutStep.with.command)).not.toContain("pipefail");
	});

	it("extracts patches against the SWE-bench base commit", () => {
		const spec = buildSwebenchInstanceWorkflowSpec({
			suiteSlug: "SWE-bench_Lite",
			datasetName: "princeton-nlp/SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			problemStatement: "Fix it",
			hintsText: null,
			agentId: "agent_1",
			agentVersion: 1,
			timeoutSeconds: 7200,
			maxTurns: null,
		});

		const extractPatch = (
			spec.do as Array<Record<string, { with: { command: string } }>>
		)[4].extract_patch;
		expect(extractPatch.with.command).toContain(
			"git diff --binary 'cffd4e0f86fefd4802349a9f9b19ed70934ea354' -- .",
		);
		expect(extractPatch.with.command).toContain("':(exclude)**/tests/**'");
		expect(extractPatch.with.command).toContain("':(exclude)testing/**'");
	});

	it("prompts agents for source-only changes and later official grading", () => {
		const spec = buildSwebenchInstanceWorkflowSpec({
			suiteSlug: "SWE-bench_Lite",
			datasetName: "princeton-nlp/SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "abc123",
			problemStatement: "Fix it",
			hintsText: null,
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
			},
			agentId: "agent_1",
			agentVersion: 1,
			timeoutSeconds: 7200,
			maxTurns: null,
		});

		const solve = (
			spec.do as Array<
				Record<string, { with: { body: { overrides: { tools: string[] }; prompt: string } } }>
			>
		)[3].solve;
		expect(solve.with.body.prompt).toContain("Official grading happens later");
		expect(solve.with.body.prompt).toContain("Work only in /sandbox/repo");
		expect(solve.with.body.prompt).toContain("editing implementation files only");
		expect(solve.with.body.prompt).toContain("Do not edit tests");
		expect(solve.with.body.prompt).toContain("final benchmark patch excludes");
		expect(solve.with.body.prompt).toContain("Do not use web search");
		expect(solve.with.body.prompt).toContain(".prepare_environment.promptNotes");
		expect(solve.with.body.overrides.tools).toEqual([
			"execute_command",
			"read_file",
			"write_file",
			"edit_file",
			"list_files",
			"glob_files",
			"grep_search",
		]);
		expect(solve.with.body.prompt).not.toContain("python3.12");
		expect(solve.with.body.prompt).not.toContain("repo-specific inference image");
	});

	it("keeps contamination-risk metadata out of the generated inference workflow", () => {
		const spec = buildSwebenchInstanceWorkflowSpec({
			runId: "run_1",
			suiteSlug: "SWE-bench_Lite",
			datasetName: "princeton-nlp/SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "abc123",
			problemStatement: "Fix it",
			hintsText: "Try the parser",
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
				FAIL_TO_PASS: ["sympy/tests/test_fix.py::test_regression"],
				PASS_TO_PASS: ["sympy/tests/test_existing.py::test_existing"],
				goldPatch: "diff --git a/sympy/core/add.py b/sympy/core/add.py\n",
			},
			agentId: "agent_1",
			agentVersion: 1,
			timeoutSeconds: 7200,
			maxTurns: null,
		});

		const serialized = JSON.stringify(spec);
		expect(serialized).not.toContain("test_patch");
		expect(serialized).not.toContain("FAIL_TO_PASS");
		expect(serialized).not.toContain("PASS_TO_PASS");
		expect(serialized).not.toContain("goldPatch");
		expect(serialized).not.toContain("/testbed");
		expect(serialized).not.toContain("sympy/tests/test_fix.py::test_regression");
		expect(serialized).not.toContain("sympy/tests/test_fix.py");

		const steps = spec.do as Array<Record<string, { with: Record<string, unknown> }>>;
		expect(steps[0].prepare_environment.with.testMetadata).toEqual({
			version: "1.7",
		});
	});

	it("surfaces max-iteration agent stops for empty SWE-bench patches", () => {
		const reason = extractAgentStopReason(
			{
				outputs: {
					solve: {
						data: {
							content:
								"I reached the maximum number of reasoning steps before I could finish. Please rephrase or provide more detail so I can try again.",
						},
					},
				},
			},
			1,
		);

		expect(reason).toBe(
			"Agent stopped after maxTurns=1 without producing a patch: I reached the maximum number of reasoning steps before I could finish. Please rephrase or provide more detail so I can try again.",
		);
		expect(extractAgentStopReason({ content: "Done" }, 80)).toBeNull();
	});

	it("uses a validated inference sandbox image when one is resolved", () => {
		const spec = buildSwebenchInstanceWorkflowSpec({
			runId: "run_1",
			suiteSlug: "SWE-bench_Lite",
			datasetName: "princeton-nlp/SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "abc123",
			problemStatement: "Fix it",
			hintsText: null,
			testMetadata: {
				version: "1.7",
				test_patch: "diff --git a/sympy/tests/test_fix.py b/sympy/tests/test_fix.py\n",
			},
			agentId: "agent_1",
			agentVersion: 1,
			timeoutSeconds: 7200,
			maxTurns: null,
			inferenceEnvironment: {
				environmentStatus: "validated",
				suite: "SWE-bench_Lite",
				repo: "sympy/sympy",
				version: "1.7",
				environmentKey: "sympy-1.7",
				sandboxTemplate: "dapr-agent",
				sandboxImage:
					"gitea-ryzen.tail286401.ts.net/giteaadmin/swebench-inference-sympy-1.7:git-abc@sha256:1111111111111111111111111111111111111111111111111111111111111111",
				digest:
					"sha256:1111111111111111111111111111111111111111111111111111111111111111",
				validationStatus: "validated",
				validationCommand: "PYTHONPATH=src python -m pytest --version",
				buildStrategy: "swebench-harness",
				workspaceRoot: "/testbed",
				condaEnvironment: "testbed",
				environmentNotes: [
					"Run Python commands with PYTHONPATH=src for source-layout repos.",
				],
			},
		});

		const workspaceProfile = (
			spec.do as Array<Record<string, { with: Record<string, unknown> }>>
		)[1].workspace_profile;
		expect(workspaceProfile.with.workspaceRef).toBe(
			"swebench-c97681e47e-run-1-sympy-sympy-20590",
		);
		expect(workspaceProfile.with.sandboxTemplate).toBe(
			'${ .prepare_environment.sandboxTemplate // "dapr-agent" }',
		);
		expect(workspaceProfile.with.rootPath).toBe("/sandbox");
		expect(workspaceProfile.with.sandboxImage).toBe(
			"${ .prepare_environment.sandboxImage }",
		);
		const prepareEnvironment = (
			spec.do as Array<Record<string, { with: Record<string, unknown> }>>
		)[0].prepare_environment;
		expect(prepareEnvironment.with).toMatchObject({
			suiteSlug: "SWE-bench_Lite",
			repo: "sympy/sympy",
			baseCommit: "abc123",
			testMetadata: {
				version: "1.7",
			},
		});
		const checkout = (
			spec.do as Array<Record<string, { with: { command: string } }>>
		)[2].checkout_repo;
		expect(checkout.with.command).toContain("cd /sandbox");
		expect(checkout.with.command).toContain("git clone 'https://github.com/sympy/sympy.git' repo");
		expect(checkout.with.command).not.toContain("/testbed");
		const solve = (spec.do as Array<Record<string, { with: { body: { prompt: string } } }>>)[3]
			.solve;
		expect(solve.with.body.prompt).toContain(".prepare_environment.promptNotes");
		expect(solve.with.body.prompt).toContain("Work only in /sandbox/repo");
		expect(solve.with.body.prompt).not.toContain("/testbed");
		expect(solve.with.body).toMatchObject({
			environmentConfig: {
				swebenchInferenceEnvironment: {
					environmentStatus:
						"${ .prepare_environment.environment.environmentStatus // null }",
					environmentKey:
						"${ .prepare_environment.environment.environmentKey // null }",
					workspaceRoot: "/sandbox/repo",
				},
			},
		});
		expect(JSON.stringify(spec)).not.toContain("/testbed");
	});

	it("keeps hidden SWE-bench environment metadata out of runtime payloads", () => {
		const runtimeEnvironment = sanitizeSwebenchInferenceEnvironmentForRuntime({
			environmentStatus: "validated",
			suite: "SWE-bench_Verified",
			repo: "pytest-dev/pytest",
			version: "4.6",
			environmentKey: "pytest-4.6",
			sandboxTemplate: "dapr-agent",
			sandboxImage:
				"ghcr.io/pittampalliorg/swebench-inference-pytest-4.6:env-abc@sha256:1111111111111111111111111111111111111111111111111111111111111111",
			digest:
				"sha256:1111111111111111111111111111111111111111111111111111111111111111",
			validationStatus: "validated",
			validationCommand: "cd /testbed && python --version",
			buildStrategy: "swebench-harness",
			workspaceRoot: "/testbed",
			condaEnvironment: "testbed",
			swebenchSpec: {
				workspaceRoot: "/testbed",
				testPatchHash: "abc",
				FAIL_TO_PASS: ["tests/test_fix.py::test_fix"],
			},
			environmentNotes: [
				"Prepared under /testbed by the SWE-bench harness.",
				"Use /sandbox/.venv/bin/python for local checks.",
			],
		});

		const serialized = JSON.stringify({
			triggerData: {
				runId: "run_1",
				instanceId: "pytest-dev__pytest-5809",
				inferenceEnvironment: runtimeEnvironment,
			},
		});
		expect(runtimeEnvironment).toMatchObject({
			workspaceRoot: "/sandbox/repo",
			environmentStatus: "validated",
			environmentKey: "pytest-4.6",
		});
		expect(runtimeEnvironment).not.toHaveProperty("validationCommand");
		expect(runtimeEnvironment).not.toHaveProperty("swebenchSpec");
		expect(serialized).not.toContain("/testbed");
		expect(serialized).not.toMatch(/test[_-]?patch/i);
		expect(serialized).not.toContain("FAIL_TO_PASS");
		expect(serialized).not.toContain("PASS_TO_PASS");
		expect(serialized).not.toContain("goldPatch");
	});

	it("profiles the workspace after dynamic environment preparation", () => {
		const spec = buildSwebenchInstanceWorkflowSpec({
			suiteSlug: "SWE-bench_Lite",
			datasetName: "princeton-nlp/SWE-bench_Lite",
			instanceId: "django__django-11099",
			repo: "django/django",
			baseCommit: "abc123",
			problemStatement: "Fix it",
			hintsText: null,
			agentId: "agent_1",
			agentVersion: 1,
			timeoutSeconds: 7200,
			maxTurns: null,
			inferenceEnvironment: {
				environmentStatus: "fallback",
				suite: "SWE-bench_Lite",
				repo: "django/django",
				sandboxTemplate: "dapr-agent",
				reason: "no_validated_mapping",
			},
		});

		const workspaceProfile = (
			spec.do as Array<Record<string, { with: Record<string, unknown> }>>
		)[1].workspace_profile;
		expect(workspaceProfile.with.rootPath).toBe("/sandbox");
		expect(workspaceProfile.with.sandboxTemplate).toBe(
			'${ .prepare_environment.sandboxTemplate // "dapr-agent" }',
		);
		expect(workspaceProfile.with.sandboxImage).toBe(
			"${ .prepare_environment.sandboxImage }",
		);
	});

	it("uses the sandbox repo path even if environment preparation reports a testbed root", () => {
		const spec = buildSwebenchInstanceWorkflowSpec({
			runId: "run_1",
			suiteSlug: "SWE-bench_Lite",
			datasetName: "princeton-nlp/SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "abc123",
			problemStatement: "Fix it",
			hintsText: null,
			agentId: "agent_1",
			agentVersion: 1,
			timeoutSeconds: 7200,
			maxTurns: null,
			inferenceEnvironment: {
				environmentStatus: "failed",
				suite: "SWE-bench_Lite",
				repo: "sympy/sympy",
				version: "1.7",
				environmentKey: "sympy-1.7",
				sandboxTemplate: "dapr-agent",
				buildStrategy: "swebench-harness",
				workspaceRoot: "/testbed",
				reason: "dynamic_build_backend_unavailable",
			},
		});

		const steps = spec.do as Array<Record<string, { with: Record<string, unknown> }>>;
		const workspaceProfile = steps[1].workspace_profile;
		const checkout = steps[2].checkout_repo;
		const solve = steps[3].solve as unknown as {
			with: { cwd: string; body: { overrides: { cwd: string }; prompt: string } };
		};
		const extractPatch = steps[4].extract_patch;

		expect(workspaceProfile.with.rootPath).toBe("/sandbox");
		expect(String(checkout.with.command)).not.toContain("/testbed");
		expect(String(checkout.with.command)).toContain("git clone 'https://github.com/sympy/sympy.git' repo");
		expect(solve.with.cwd).toBe("/sandbox/repo");
		expect(solve.with.body.overrides.cwd).toBe("/sandbox/repo");
		expect(solve.with.body.prompt).not.toContain("Work only in /testbed");
		expect(solve.with.body.prompt).toContain("Work only in /sandbox/repo");
		expect(String(extractPatch.with.command)).not.toContain("/testbed");
		expect(String(extractPatch.with.command)).toContain("cd '/sandbox/repo'");
		expect(JSON.stringify(spec)).not.toContain("/testbed");
	});

	it("projects sandbox, workspace, and trace links from workflow/session telemetry", () => {
		const links = extractBenchmarkRuntimeLinks({
			currentSandboxName: null,
			currentWorkspaceRef: null,
			currentTraceIds: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
			sessionSandboxName: "ws-session",
			sessionWorkspaceSandboxName: null,
			values: [
				{
					outputs: {
						workspace_profile: {
							workspaceRef: "ws_profile",
							sandboxName: "ws-profile-sandbox",
						},
					},
				},
				{
					traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
					codeCheckpoint: {
						workspaceRef: "ws_checkpoint",
						sandboxName: "ws-checkpoint-sandbox",
					},
				},
			],
		});

		expect(links).toEqual({
			sandboxName: "ws-session",
			workspaceRef: "ws_profile",
			traceIds: [
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			],
		});
	});

	it("prefers the validated inference environment over planned trigger metadata", () => {
		const environment = extractInferenceEnvironment({
			input: {
				inferenceEnvironment: {
					environmentStatus: "building",
					environmentKey: "requests-2.4",
				},
			},
			outputs: {
				prepare_environment: {
					environment: {
						environmentStatus: "validated",
						environmentKey: "requests-2.4",
						sandboxImage:
							"ghcr.io/pittampalliorg/swebench-inference-requests-2.4:env-abc@sha256:1111111111111111111111111111111111111111111111111111111111111111",
						digest:
							"sha256:1111111111111111111111111111111111111111111111111111111111111111",
						validationLogRef: "tekton://taskruns/swe-env-abc-validate-image",
					},
				},
				solve: {
					environmentConfig: {
						swebenchInferenceEnvironment: {
							environmentStatus: "building",
							environmentKey: "requests-2.4",
						},
					},
				},
			},
		});

		expect(environment).toMatchObject({
			environmentStatus: "validated",
			environmentKey: "requests-2.4",
			digest:
				"sha256:1111111111111111111111111111111111111111111111111111111111111111",
		});
	});

	it("collects benchmark trace ids only from trace-shaped fields", () => {
		expect(
			collectBenchmarkTraceIds(
				{ primaryTraceId: "0123456789abcdef0123456789abcdef" },
				{
					patchSha256:
						"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					nested: { trace_ids: ["fedcba9876543210fedcba9876543210"] },
				},
			),
		).toEqual([
			"0123456789abcdef0123456789abcdef",
			"fedcba9876543210fedcba9876543210",
		]);
	});

	it("preserves evaluator-owned instance status when inference is re-synced", () => {
		expect(resolveBenchmarkInferenceStatus("success")).toBe("inferred");
		expect(resolveBenchmarkInferenceStatus("error")).toBe("error");
		expect(resolveBenchmarkInstanceStatusAfterInference("inferencing", "success")).toBe(
			"inferred",
		);
		expect(resolveBenchmarkInstanceStatusAfterInference("resolved", "success")).toBe(
			"resolved",
		);
		expect(resolveBenchmarkInstanceStatusAfterInference("failed", "success")).toBe(
			"failed",
		);
		expect(resolveBenchmarkInstanceStatusAfterInference("evaluating", "error")).toBe(
			"evaluating",
		);
	});
});

describe("SWE-bench terminal run cleanup", () => {
	const now = new Date("2026-05-02T12:00:00Z");

	it("terminates only the session workflow and latest turn workflow", () => {
		expect(
			benchmarkAgentRuntimeCleanupInstanceIds(
				{
					runtimeAppId: "agent-runtime-pool-coding",
					sessionId: "session-1",
					turnCount: 12,
				},
				{
					sessionId: "session-1",
					childInstanceId: "session-1:turn-12",
					turn: 12,
				},
			),
		).toEqual(["session-1", "session-1:turn-12"]);

		expect(
			benchmarkAgentRuntimeCleanupInstanceIds({
				runtimeAppId: "agent-runtime-pool-coding",
				sessionId: "session-2",
				turnCount: 7,
			}),
		).toEqual(["session-2", "session-2:turn-7"]);
	});

	it("classifies already-gone Dapr workflow instances as benign", () => {
		expect(isBenignDaprTerminationMiss("failed: no such instance exists")).toBe(true);
		expect(isBenignDaprTerminationMiss("Agent run not found")).toBe(true);
		expect(isBenignDaprTerminationMiss(new Error("workflow instance not found"))).toBe(true);
		expect(isBenignDaprTerminationMiss(new Error("context deadline exceeded"))).toBe(false);
	});

	it("cancels active inference rows without marking pending evaluation as evaluated", () => {
		const patch = benchmarkRunInstanceTerminalPatch(
			{
				status: "inferencing",
				inferenceStatus: "inferencing",
				evaluationStatus: "pending",
				error: null,
				inferenceError: null,
				evaluationError: null,
				terminationReason: null,
				inferenceCompletedAt: null,
				evaluatedAt: null,
			},
			"cancelled",
			"cancelled by user",
			now,
		);

		expect(patch).toMatchObject({
			status: "cancelled",
			inferenceStatus: "cancelled",
			evaluationStatus: "cancelled",
			error: "cancelled by user",
			inferenceError: "cancelled by user",
			evaluationError: "cancelled by user",
			terminationReason: "benchmark_run_cancelled",
			inferenceCompletedAt: now,
			updatedAt: now,
		});
		expect(patch).not.toHaveProperty("evaluatedAt");
	});

	it("marks failed evaluating rows as evaluation errors while preserving inferred state", () => {
		const inferenceCompletedAt = new Date("2026-05-02T11:58:00Z");
		const patch = benchmarkRunInstanceTerminalPatch(
			{
				status: "evaluating",
				inferenceStatus: "inferred",
				evaluationStatus: "evaluating",
				error: null,
				inferenceError: null,
				evaluationError: null,
				terminationReason: null,
				inferenceCompletedAt,
				evaluatedAt: null,
			},
			"failed",
			"coordinator failed",
			now,
		);

		expect(patch).toMatchObject({
			status: "error",
			evaluationStatus: "error",
			error: "coordinator failed",
			evaluationError: "coordinator failed",
			terminationReason: "benchmark_run_failed",
			evaluatedAt: now,
			updatedAt: now,
		});
		expect(patch).not.toHaveProperty("inferenceStatus");
		expect(patch).not.toHaveProperty("inferenceCompletedAt");
	});

	it("overrides weak end-turn reasons during terminal run cleanup", () => {
		const patch = benchmarkRunInstanceTerminalPatch(
			{
				status: "inferencing",
				inferenceStatus: "inferencing",
				evaluationStatus: "pending",
				error: null,
				inferenceError: null,
				evaluationError: null,
				terminationReason: "end_turn",
				inferenceCompletedAt: null,
				evaluatedAt: null,
			},
			"failed",
			"run failed",
			now,
		);

		expect(patch).toMatchObject({
			status: "error",
			inferenceStatus: "error",
			terminationReason: "benchmark_run_failed",
		});
	});

	it("leaves already-terminal rows untouched", () => {
		expect(
			benchmarkRunInstanceTerminalPatch(
				{
					status: "resolved",
					inferenceStatus: "inferred",
					evaluationStatus: "resolved",
					error: null,
					inferenceError: null,
					evaluationError: null,
					terminationReason: null,
					inferenceCompletedAt: now,
					evaluatedAt: now,
				},
				"failed",
				"late coordinator failure",
				now,
			),
		).toBeNull();
	});
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__benchmarkDurableRuntimeForTest,
	__benchmarkSandboxCleanupForTest,
	benchmarkInferenceStallSeconds,
	benchmarkInferenceStallRetryCount,
	benchmarkInferenceStallRetryLimit,
	benchmarkInferenceStallState,
	benchmarkInstanceStartReuseResult,
	benchmarkAgentRuntimeCleanupInstanceIds,
	benchmarkAgentRuntimeCleanupRuntimeAppIds,
	benchmarkRunUsesAgentWorkflowHosts,
	benchmarkRunInstanceTerminalPatch,
	benchmarkSuccessfulEmptyPatchTerminationReason,
	benchmarkSessionHostAppId,
	buildSwebenchInstanceWorkflowGraph,
	buildSwebenchInstanceScript,
	buildSwebenchInstanceWorkflowSpec,
	benchmarkLaunchPreflightError,
	completedBenchmarkRunHasDurableWorkflowTarget,
	collectBenchmarkTraceIds,
	cleanupBenchmarkTerminalResourcesAfterDurableClosure,
	effectiveBenchmarkConcurrency,
	extractAgentStopReason,
	extractBenchmarkRuntimeLinks,
	extractInferenceEnvironment,
	extractModelPatch,
	isBenignDaprTerminationMiss,
	resolveBenchmarkInferenceStatus,
	resolveBenchmarkInstanceStatusAfterInference,
	sanitizeSwebenchInferenceEnvironmentForRuntime,
	shouldFinalizeBenchmarkLifecycle,
	shouldRunFullBenchmarkRunRecompute,
	shouldTerminateCompletedBenchmarkSessionProjection,
} from "./service";
import type { BenchmarkSandboxCapacitySnapshot } from "./sandbox-capacity";
import {
	buildSwebenchDatasetJsonl,
	findMissingSwebenchMetadata,
	isCompleteSwebenchInstanceMetadata,
} from "./swebench";

afterEach(() => {
	vi.unstubAllEnvs();
});

function validatedInferenceEnvironment(
	overrides: Record<string, unknown> = {},
) {
	return {
		environmentStatus: "validated" as const,
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
		buildStrategy: "swebench-harness",
		workspaceRoot: "/testbed",
		condaEnvironment: "testbed",
		environmentNotes: [
			"Run Python commands with PYTHONPATH=src for source-layout repos.",
		],
		...overrides,
	};
}

function sandboxCapacity(
	overrides: Partial<BenchmarkSandboxCapacitySnapshot> = {},
): BenchmarkSandboxCapacitySnapshot {
	return {
		sampledAt: "2026-05-21T00:00:00.000Z",
		namespace: "openshell",
		podScope: "all-namespaces",
		nodeCount: 6,
		allocatableCpuMilli: 96000,
		allocatableMemoryBytes: 192 * 1024 * 1024 * 1024,
		allocatableEphemeralStorageBytes: 1024 * 1024 * 1024 * 1024,
		requestedCpuMilli: 0,
		requestedMemoryBytes: 0,
		requestedEphemeralStorageBytes: 0,
		pendingSwebenchCpuMilli: 0,
		pendingSwebenchMemoryBytes: 0,
		pendingSwebenchEphemeralStorageBytes: 0,
		availableCpuMilli: 96000,
		availableMemoryBytes: 192 * 1024 * 1024 * 1024,
		availableEphemeralStorageBytes: 1024 * 1024 * 1024 * 1024,
		sandboxRequestCpuMilli: 100,
		sandboxRequestMemoryBytes: 256 * 1024 * 1024,
		sandboxRequestEphemeralStorageBytes: 1024 * 1024 * 1024,
		availableSandboxSlots: 32,
		totalSchedulableSandboxCapacity: 32,
		schedulableSandboxCapacity: 32,
		cpuLimitedCapacity: 960,
		memoryLimitedCapacity: 768,
		ephemeralStorageLimitedCapacity: 1024,
		nodeFsAvailableBytes: null,
		nodeFsCapacityBytes: null,
		nodeFsEvictionReserveBytes: 24 * 1024 * 1024 * 1024,
		nodeFsLimitedCapacity: null,
		kueueClusterQueueName: "benchmark-fast",
		kueueClusterQueueActive: true,
		kueueClusterQueueReason: "Ready",
		kueueClusterQueueMessage: "Can admit new workloads",
		kueueAvailableSandboxSlots: 32,
		kueueBorrowAvailableSandboxSlots: 48,
		kueueCpuLimitedCapacity: 80,
		kueueMemoryLimitedCapacity: 72,
		kueueEphemeralStorageLimitedCapacity: 37,
		kueuePodLimitedCapacity: 32,
		kueueInstanceRequestCpuMilli: 450,
		kueueInstanceRequestMemoryBytes: 1073741824,
		kueueInstanceRequestEphemeralStorageBytes: 7021273088,
		kueueInstancePodCount: 3,
		kueueInstancePodCountScope: "modeled_composite_budget",
		kueueInstanceRequestMode: "host-worker-composite",
		kueueAvailableInstanceSlots: 5,
		kueueBorrowAvailableInstanceSlots: 7,
		kueueInstanceCpuLimitedCapacity: 17,
		kueueInstanceMemoryLimitedCapacity: 18,
		kueueInstanceEphemeralStorageLimitedCapacity: 5,
		kueueInstancePodLimitedCapacity: 10,
		schedulableKueueInstanceCapacity: 5,
		activeSwebenchPods: 0,
		pendingSwebenchPods: 0,
		diskPressureNodeCount: 0,
		...overrides,
	};
}

describe("SWE-bench launch preflight", () => {
	it("allows healthy Kueue-backed launches", () => {
		expect(
			benchmarkLaunchPreflightError({
				executionBackend: "dapr-kueue",
				sandboxCapacity: sandboxCapacity(),
			}),
		).toBeNull();
	});

	it("rejects inactive Kueue ClusterQueues before creating a run", () => {
		expect(
			benchmarkLaunchPreflightError({
				executionBackend: "dapr-kueue",
				sandboxCapacity: sandboxCapacity({
					kueueClusterQueueActive: false,
					kueueClusterQueueReason: "AdmissionCheckInactive",
					kueueClusterQueueMessage:
						"references inactive AdmissionCheck(s): psi-memory-pressure",
				}),
			}),
		).toContain("AdmissionCheckInactive");
	});

	it("rejects zero Kueue full-instance capacity", () => {
		expect(
			benchmarkLaunchPreflightError({
				executionBackend: "dapr-kueue",
				sandboxCapacity: sandboxCapacity({
					schedulableKueueInstanceCapacity: 0,
				}),
			}),
		).toContain("zero full-instance capacity");
	});

	it("rejects ResourceFlavor/node-selector capacity gaps", () => {
		expect(
			benchmarkLaunchPreflightError({
				executionBackend: "dapr-kueue",
				sandboxCapacity: sandboxCapacity({
					schedulableKueueInstanceCapacity: null,
					schedulableSandboxCapacity: 0,
				}),
			}),
		).toContain("ResourceFlavor node labels");
	});

	it("does not block legacy Dapr launches", () => {
		expect(
			benchmarkLaunchPreflightError({
				executionBackend: "legacy-dapr",
				sandboxCapacity: sandboxCapacity({
					kueueClusterQueueActive: false,
					schedulableSandboxCapacity: 0,
				}),
			}),
		).toBeNull();
	});
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
	it("uses the same host execution label values as sandbox-execution-api", () => {
		expect(
			__benchmarkSandboxCleanupForTest.benchmarkRunLabelValue(
				"rwPVt8a69bC2qwVwn9-_H",
			),
		).toBe("rwpvt8a69bc2qwvwn9--h");
		expect(
			__benchmarkSandboxCleanupForTest.benchmarkInstanceLabelValue(
				"sympy__sympy-20590",
			),
		).toBe("sympy-sympy-20590");
	});

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
		).toEqual({ concurrency: 5, evaluationConcurrency: 24 });
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
				latestProgressEventCreatedAt: new Date("2026-05-02T12:01:30Z"),
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
				latestProgressEventCreatedAt: new Date("2026-05-02T12:06:00Z"),
			}).stalled,
		).toBe(false);

		const recentHeartbeatOnly = {
			now,
			stallSeconds: 480,
			startedAt: new Date("2026-05-02T12:00:00Z"),
			latestProgressEventCreatedAt: new Date("2026-05-02T12:01:30Z"),
			latestHeartbeatAt: new Date("2026-05-02T12:09:59Z"),
		} as Parameters<typeof benchmarkInferenceStallState>[0] & { latestHeartbeatAt: Date };
		expect(benchmarkInferenceStallState(recentHeartbeatOnly).stalled).toBe(true);
	});

	it("reuses an already claimed benchmark instance start", () => {
		expect(
			benchmarkInstanceStartReuseResult({
				status: "inferencing",
				inferenceStatus: "inferencing",
				workflowExecutionId: "exec_123",
				daprInstanceId: "sw-exec_123",
			}),
		).toEqual({
			executionId: "exec_123",
			daprInstanceId: "sw-exec_123",
			idempotent: true,
			reason: "benchmark_instance_already_started",
		});

		expect(
			benchmarkInstanceStartReuseResult({
				status: "queued",
				inferenceStatus: "queued",
				workflowExecutionId: null,
				daprInstanceId: null,
			}),
		).toBeNull();
		expect(
			benchmarkInstanceStartReuseResult({
				status: "inferencing",
				inferenceStatus: "inferencing",
				workflowExecutionId: null,
				daprInstanceId: null,
			}),
		).toBeNull();
	});

	it("does not count initial user messages as progress for rescheduling sessions", () => {
		expect(
			__benchmarkDurableRuntimeForTest.benchmarkInstanceProgressEventTypesForSession(
				"rescheduling",
			),
		).not.toContain("user.message");
		expect(
			__benchmarkDurableRuntimeForTest.benchmarkInstanceProgressEventTypesForSession(
				"running",
			),
		).toContain("user.message");
	});

	it("uses a shorter stall window for one-turn benchmark canaries", () => {
		expect(benchmarkInferenceStallSeconds(null)).toBe(2400);
		expect(benchmarkInferenceStallSeconds(4)).toBe(2400);
		expect(benchmarkInferenceStallSeconds(1)).toBe(600);

		vi.stubEnv("BENCHMARK_INFERENCE_STALL_SECONDS", "2400");
		expect(benchmarkInferenceStallSeconds(1)).toBe(600);
		expect(benchmarkInferenceStallSeconds(2)).toBe(2400);
		vi.unstubAllEnvs();

		vi.stubEnv("BENCHMARK_SHORT_RUN_INFERENCE_STALL_SECONDS", "900");
		expect(benchmarkInferenceStallSeconds(1)).toBe(900);
		expect(benchmarkInferenceStallSeconds(2)).toBe(2400);
	});

	it("bounds stalled inference retries by termination reason", () => {
		expect(benchmarkInferenceStallRetryLimit()).toBe(1);
		expect(benchmarkInferenceStallRetryCount(null)).toBe(0);
		expect(benchmarkInferenceStallRetryCount("no_session_progress")).toBe(0);
		expect(benchmarkInferenceStallRetryCount("no_session_progress_retry_2")).toBe(2);

		vi.stubEnv("BENCHMARK_INFERENCE_STALL_RETRY_LIMIT", "3");
		expect(benchmarkInferenceStallRetryLimit()).toBe(3);
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

	it("keeps active benchmark run recompute on the lightweight path", () => {
		expect(shouldRunFullBenchmarkRunRecompute("queued")).toBe(false);
		expect(shouldRunFullBenchmarkRunRecompute("inferencing")).toBe(false);
		expect(shouldRunFullBenchmarkRunRecompute("evaluating")).toBe(false);
		expect(shouldRunFullBenchmarkRunRecompute("completed")).toBe(true);
		expect(shouldRunFullBenchmarkRunRecompute("failed")).toBe(true);
		expect(shouldRunFullBenchmarkRunRecompute("cancelled")).toBe(true);
	});

	it("builds a canvas graph for generated SWE-bench instance runs", () => {
		const graph = buildSwebenchInstanceWorkflowGraph();
		const nodes = graph.nodes as Array<{ id: string; type: string }>;
		const edges = graph.edges as Array<{ source: string; target: string }>;
		expect(nodes.map((node) => node.id)).toEqual([
			"__start__",
			"workspace_profile",
			"checkout_repo",
			"solve",
			"extract_patch",
			"__end__",
		]);
		expect(nodes.find((node) => node.id === "solve")?.type).toBe("agent");
		expect(edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
			"__start__->workspace_profile",
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
			inferenceEnvironment: validatedInferenceEnvironment(),
		});

		const steps = spec.do as Array<Record<string, { with: Record<string, unknown> }>>;
		const workspaceProfile = steps[0].workspace_profile;
		const checkoutStep = steps[1].checkout_repo;
		expect(workspaceProfile.with.sandboxImage).toBe(
			validatedInferenceEnvironment().sandboxImage,
		);
		expect(workspaceProfile.with.capacityOwnerLabels).toEqual({
			"benchmark-run-id": "run-1",
			"benchmark-instance-id": "sympy-sympy-20590",
		});
		expect(String(checkoutStep.with.command)).toContain("set -eu\n");
		expect(String(checkoutStep.with.command)).not.toContain("pipefail");
		expect(String(checkoutStep.with.command)).toContain(
			"git -c protocol.version=2 fetch --depth=1 origin 'abc123'",
		);
		expect(String(checkoutStep.with.command)).toContain(
			"git clone --filter=blob:none --no-checkout 'https://github.com/sympy/sympy.git' \"$tmp_repo\"",
		);
		expect(String(checkoutStep.with.command)).toContain(
			"lock_dir=/sandbox/.swebench-checkout.lock",
		);
		expect(String(checkoutStep.with.command)).toContain(
			"git -C repo rev-parse HEAD",
		);
	});

	it("keeps SWE-bench sandboxes through patch extraction", () => {
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
			inferenceEnvironment: validatedInferenceEnvironment(),
		});

		const steps = spec.do as Array<Record<string, { with: Record<string, unknown> }>>;
		const workspaceProfile = steps[0].workspace_profile;
		const solve = steps[2].solve as unknown as {
			with: { sandboxPolicy: { keepAfterRun: boolean } };
		};
		expect(workspaceProfile.with.keepAfterRun).toBe(true);
		expect(workspaceProfile.with.sandboxPolicy).toMatchObject({
			keepAfterRun: true,
		});
		expect(solve.with.sandboxPolicy.keepAfterRun).toBe(true);
		expect(steps.some((step) => "cleanup_workspace" in step)).toBe(false);
	});

	it("does not generate per-instance environment build or ensure steps", () => {
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
			inferenceEnvironment: validatedInferenceEnvironment(),
		});

		const steps = spec.do as Array<Record<string, { call: string }>>;
		const taskEntries = steps.flatMap((step) => Object.entries(step));
		expect(taskEntries.map(([name]) => name)).toEqual([
			"workspace_profile",
			"checkout_repo",
			"solve",
			"extract_patch",
		]);
		for (const [name, task] of taskEntries) {
			expect(name).not.toMatch(/build|ensure|environment/i);
			expect(task.call).not.toMatch(/build|ensure|environment/i);
		}
	});

	it("can retain SWE-bench sandboxes when explicitly enabled", () => {
		vi.stubEnv("SWEBENCH_KEEP_SANDBOX_AFTER_RUN", "true");
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
			inferenceEnvironment: validatedInferenceEnvironment(),
		});

		const steps = spec.do as Array<Record<string, { with: Record<string, unknown> }>>;
		const workspaceProfile = steps[0].workspace_profile;
		const solve = steps[2].solve as unknown as {
			with: { sandboxPolicy: { keepAfterRun: boolean } };
		};
		expect(workspaceProfile.with.keepAfterRun).toBe(true);
		expect(workspaceProfile.with.sandboxPolicy).toMatchObject({
			keepAfterRun: true,
		});
		expect(solve.with.sandboxPolicy.keepAfterRun).toBe(true);
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
			inferenceEnvironment: validatedInferenceEnvironment({
				baseCommit: "cffd4e0f86fefd4802349a9f9b19ed70934ea354",
			}),
		});

		const extractPatch = (
			spec.do as Array<Record<string, { with: { command: string } }>>
		)[3].extract_patch;
		expect(extractPatch.with.command).toContain(
			"git diff --binary 'cffd4e0f86fefd4802349a9f9b19ed70934ea354' -- .",
		);
		expect(extractPatch.with.command).toContain("':(exclude)**/tests/**'");
		expect(extractPatch.with.command).toContain("':(exclude)testing/**'");
	});

	it("lets Claude SWE-bench runs return patches from the runtime sandbox", () => {
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
			inferenceEnvironment: validatedInferenceEnvironment(),
			agentRuntime: "claude-agent-py",
		});

		const steps = spec.do as Array<Record<string, { with: Record<string, unknown> }>>;
		const solve = steps[2].solve;
		expect(solve.with.agentRuntime).toBe("claude-agent-py");
		expect((spec.output as { as: Record<string, unknown> }).as.modelPatch).toBe(
			"${ .solve.modelPatch // .extract_patch.modelPatch }",
		);
		expect((spec.output as { as: Record<string, unknown> }).as.sandboxName).toBe(
			"${ .solve.runtimeSandboxName // .workspace_profile.sandboxName }",
		);
	});

	it("lets interactive CLI SWE-bench runs return patches from the runtime sandbox", () => {
		const spec = buildSwebenchInstanceWorkflowSpec({
			runId: "run_1",
			suiteSlug: "SWE-bench_Lite",
			datasetName: "princeton-nlp/SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "abc123",
			problemStatement: "Fix it",
			hintsText: null,
			agentId: "agent_cli",
			agentVersion: 1,
			timeoutSeconds: 7200,
			maxTurns: null,
			inferenceEnvironment: validatedInferenceEnvironment(),
			agentRuntime: "codex-cli",
		});

		const steps = spec.do as Array<Record<string, { with: Record<string, unknown> }>>;
		const solve = steps[2].solve;
		expect(solve.with.agentRuntime).toBe("codex-cli");
		expect((spec.output as { as: Record<string, unknown> }).as.modelPatch).toBe(
			"${ .solve.modelPatch // .extract_patch.modelPatch }",
		);
		expect((spec.output as { as: Record<string, unknown> }).as.sandboxName).toBe(
			"${ .solve.runtimeSandboxName // .workspace_profile.sandboxName }",
		);
	});

	it("only extracts authoritative SWE-bench model patches", () => {
		const patch = "diff --git a/sympy/core/add.py b/sympy/core/add.py\n";
		expect(extractModelPatch({ modelPatch: patch })).toBe(patch);
		expect(extractModelPatch({ model_patch: patch })).toBe(patch);
		expect(
			extractModelPatch({
				stdout: patch,
				output: `preview: ${patch}`,
				content: `agent said ${patch}`,
			}),
		).toBe("");
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
			inferenceEnvironment: validatedInferenceEnvironment(),
		});

		const solve = (
			spec.do as Array<
				Record<string, { with: { body: { overrides: { tools: string[] }; prompt: string } } }>
			>
		)[2].solve;
		expect(solve.with.body.prompt).toContain("Official grading happens later");
		expect(solve.with.body.prompt).toContain("Work only in /sandbox/repo");
		expect(solve.with.body.prompt).toContain("editing implementation files only");
		expect(solve.with.body.prompt).toContain(
			"The runtime may create internal checkpoint commits",
		);
		expect(solve.with.body.prompt).toContain(
			"git diff --binary abc123 -- .",
		);
		expect(solve.with.body.prompt).toContain("Do not edit tests");
		expect(solve.with.body.prompt).toContain("final benchmark patch excludes");
		expect(solve.with.body.prompt).toContain("Do not use web search");
		expect(solve.with.body.prompt).toContain(
			"This run is using a SWE-bench harness spec image",
		);
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
			inferenceEnvironment: validatedInferenceEnvironment(),
		});

		const serialized = JSON.stringify(spec);
		expect(serialized).not.toContain("test_patch");
		expect(serialized).not.toContain("FAIL_TO_PASS");
		expect(serialized).not.toContain("PASS_TO_PASS");
		expect(serialized).not.toContain("goldPatch");
		expect(serialized).not.toContain("/testbed");
		expect(serialized).not.toContain("sympy/tests/test_fix.py::test_regression");
		expect(serialized).not.toContain("sympy/tests/test_fix.py");

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

	it("classifies max-turn empty patches as a terminal model outcome", () => {
		expect(
			benchmarkSuccessfulEmptyPatchTerminationReason(
				"end_turn",
				"Agent stopped after maxTurns=10 without producing a patch",
			),
		).toBe("max_turns_without_patch");
		expect(
			benchmarkSuccessfulEmptyPatchTerminationReason(
				"tool_error",
				"Agent stopped after maxTurns=10 without producing a patch",
			),
		).toBe("tool_error");
		expect(
			benchmarkSuccessfulEmptyPatchTerminationReason("end_turn", null),
		).toBe("end_turn");
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
			inferenceEnvironment: validatedInferenceEnvironment({
				sandboxImage:
					"gitea-ryzen.tail286401.ts.net/giteaadmin/swebench-inference-sympy-1.7:git-abc@sha256:1111111111111111111111111111111111111111111111111111111111111111",
				validationCommand: "PYTHONPATH=src python -m pytest --version",
			}),
		});

		const workspaceProfile = (
			spec.do as Array<Record<string, { with: Record<string, unknown> }>>
		)[0].workspace_profile;
		expect(workspaceProfile.with.workspaceRef).toBe(
			"swebench-c97681e47e-run-1-sympy-sympy-20590",
		);
		expect(workspaceProfile.with.sandboxTemplate).toBe("dapr-agent");
		expect(workspaceProfile.with.rootPath).toBe("/sandbox");
		expect(workspaceProfile.with.sandboxImage).toBe(
			"gitea-ryzen.tail286401.ts.net/giteaadmin/swebench-inference-sympy-1.7:git-abc@sha256:1111111111111111111111111111111111111111111111111111111111111111",
		);
		const checkout = (
			spec.do as Array<Record<string, { with: { command: string } }>>
		)[1].checkout_repo;
		expect(checkout.with.command).toContain("cd /sandbox");
		expect(checkout.with.command).toContain("git remote add origin 'https://github.com/sympy/sympy.git'");
		expect(checkout.with.command).toContain("git checkout --force FETCH_HEAD");
		expect(checkout.with.command).toContain("mv \"$tmp_repo\" repo");
		expect(checkout.with.command).not.toContain("/testbed");
		const solve = (spec.do as Array<Record<string, { with: { body: { prompt: string } } }>>)[2]
			.solve;
		expect(solve.with.body.prompt).toContain(
			"This run is using a SWE-bench harness spec image",
		);
		expect(solve.with.body.prompt).toContain("Work only in /sandbox/repo");
		expect(solve.with.body.prompt).not.toContain("/testbed");
		expect(solve.with.body).toMatchObject({
			environmentConfig: {
				swebenchInferenceEnvironment: {
					environmentStatus: "validated",
					environmentKey: "sympy-1.7",
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

	it("rejects non-validated inference environments", () => {
		expect(() =>
			buildSwebenchInstanceWorkflowSpec({
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
			}),
		).toThrow("missing a prevalidated inference environment");
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
			inferenceEnvironment: validatedInferenceEnvironment({
				workspaceRoot: "/testbed",
			}),
		});

		const steps = spec.do as Array<Record<string, { with: Record<string, unknown> }>>;
		const workspaceProfile = steps[0].workspace_profile;
		const checkout = steps[1].checkout_repo;
		const solve = steps[2].solve as unknown as {
			with: { cwd: string; body: { overrides: { cwd: string }; prompt: string } };
		};
		const extractPatch = steps[3].extract_patch;

		expect(workspaceProfile.with.rootPath).toBe("/sandbox");
		expect(String(checkout.with.command)).not.toContain("/testbed");
		expect(String(checkout.with.command)).toContain(
			"git -c protocol.version=2 fetch --depth=1 origin 'abc123'",
		);
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
			sessionRuntimeSandboxName: "agent-host-session",
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
			sandboxName: "agent-host-session",
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
				{ primaryTraceId: "tr-0123456789abcdef0123456789abcdef" },
				{
					patchSha256:
						"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					traceId: "not-a-trace",
					nested: {
						trace_ids: [
							"fedcba9876543210fedcba9876543210",
							"00000000000000000000000000000000",
						],
					},
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

	it("terminates the session workflow without synthesizing per-turn workflows", () => {
		expect(
			benchmarkAgentRuntimeCleanupInstanceIds(
				{
					runtimeAppId: "agent-runtime-pool-coding",
					sessionId: "session-1",
					turnCount: 12,
				},
				{
					sessionId: "session-1",
					childInstanceId: "session-1",
					turn: 12,
					agentWorkflowMode: "session-native",
				},
			),
		).toEqual(["session-1"]);

		expect(
			benchmarkAgentRuntimeCleanupInstanceIds({
				runtimeAppId: "agent-runtime-pool-coding",
				sessionId: "session-2",
				turnCount: 7,
			}),
		).toEqual(["session-2"]);

		expect(
			benchmarkAgentRuntimeCleanupInstanceIds(
				{
					runtimeAppId: "agent-runtime-pool-coding",
					sessionId: "session-3",
					turnCount: 2,
				},
				[
					{
						sessionId: "session-3",
						childInstanceId: "custom-child-a",
						turn: 1,
					},
					{
						sessionId: "session-3",
						childInstanceId: "custom-child-b",
						turn: 2,
					},
				],
			),
		).toEqual([
			"session-3",
			"custom-child-a",
			"custom-child-b",
		]);
	});

	it("derives per-session workflow host app ids for Kueue-backed benchmark runs", () => {
		expect(benchmarkSessionHostAppId("session-1")).toBe(
			"agent-session-84097828fc31a8c8d292",
		);
		expect(benchmarkSessionHostAppId("  ")).toBeNull();
		expect(
			benchmarkRunUsesAgentWorkflowHosts({
				execution: { backend: "host-execution", class: "benchmark-fast" },
			}),
		).toBe(true);
		expect(
			benchmarkRunUsesAgentWorkflowHosts({
				execution: { backend: "dapr-kueue", class: "benchmark-fast" },
			}),
		).toBe(true);
		expect(
			benchmarkRunUsesAgentWorkflowHosts({
				execution: { backend: "legacy-dapr" },
			}),
		).toBe(false);
		expect(benchmarkRunUsesAgentWorkflowHosts({})).toBe(false);
	});

	it("classifies already-gone Dapr workflow instances as benign", () => {
		expect(isBenignDaprTerminationMiss("failed: no such instance exists")).toBe(true);
		expect(isBenignDaprTerminationMiss("Agent run not found")).toBe(true);
		expect(isBenignDaprTerminationMiss(new Error("workflow instance not found"))).toBe(true);
		expect(
			isBenignDaprTerminationMiss(
				"failed to invoke, id: agent-runtime-deepseek-v4-pro-swebench, err: failed to resolve address for 'agent-runtime-deepseek-v4-pro-swebench-dapr.workflow-builder.svc.cluster.local': no such host",
			),
		).toBe(true);
		expect(isBenignDaprTerminationMiss(new Error("context deadline exceeded"))).toBe(false);
	});

	it("extracts durable runtime status from nested response envelopes", () => {
		expect(
			__benchmarkDurableRuntimeForTest.durableRuntimeStatusFromBody({
				status: { runtimeStatus: "TERMINATED" },
			}),
		).toBe("TERMINATED");
		expect(
			__benchmarkDurableRuntimeForTest.durableRuntimeStatusFromBody({
				runtime_status: "COMPLETED",
			}),
		).toBe("COMPLETED");
	});

	it("preserves top-level workflow status errors when outputs are empty", () => {
		expect(
			__benchmarkDurableRuntimeForTest.runtimeOutputFromWorkflowStatusBody(
				{
					runtimeStatus: "FAILED",
					outputs: null,
					error: "NonDeterminismError: replay mismatch",
					stackTrace: "durabletask stack",
				},
				{ fallback: true },
			),
		).toMatchObject({
			error: "NonDeterminismError: replay mismatch",
			stackTrace: "durabletask stack",
		});
		expect(
			__benchmarkDurableRuntimeForTest.runtimeOutputFromWorkflowStatusBody(
				{ runtimeStatus: "COMPLETED", outputs: { ok: true } },
				{ fallback: true },
			),
		).toEqual({ ok: true });
	});

	it("does not let stale Dapr status downgrade a terminal DB projection", () => {
		expect(
			__benchmarkDurableRuntimeForTest.benchmarkSyncExecutionStatus({
				dbStatus: "success",
				phase: "completed",
				completedAt: new Date("2026-05-08T07:00:00Z"),
				error: null,
				output: { patch: "diff --git a/file b/file\n" },
				runtimeStatus: "RUNNING",
			}),
		).toBe("success");
		expect(
			__benchmarkDurableRuntimeForTest.benchmarkSyncExecutionStatus({
				dbStatus: "running",
				phase: "running",
				completedAt: null,
				error: null,
				output: null,
				runtimeStatus: "COMPLETED",
			}),
		).toBe("success");
	});

	it("treats a naturally terminated benchmark session as terminal evidence", () => {
		expect(
			__benchmarkDurableRuntimeForTest.benchmarkTerminatedSessionExecutionStatus(
				{ status: "terminated", errorMessage: null },
				[
					{ type: "session.turn_started", data: {} },
					{ type: "instance.metrics_summary", data: { termination_reason: "max_iters" } },
					{ type: "session.status_terminated", data: { reason: "auto" } },
				],
			),
		).toBe("success");
		expect(
			__benchmarkDurableRuntimeForTest.benchmarkTerminatedSessionExecutionStatus(
				{ status: "terminated", errorMessage: "agent failed" },
				[{ type: "instance.metrics_summary", data: {} }],
			),
		).toBe("error");
		expect(
			__benchmarkDurableRuntimeForTest.benchmarkTerminatedSessionExecutionStatus(
				{ status: "terminated", errorMessage: null },
				[{ type: "session.status_terminated", data: { reason: "operator cleanup" } }],
			),
		).toBeNull();
	});

	it("terminates parent workflows after child/session-host termination", async () => {
		const calls: string[] = [];
		const result =
			await __benchmarkDurableRuntimeForTest.cleanupBenchmarkDurableWorkflowCascade({
				parentInstanceIds: ["parent-1"],
				agentRuntimeTargets: [
					{ runtimeAppId: "agent-session-host", instanceId: "session-1" },
				],
				reason: "operator cleanup",
				purge: true,
				purgeGraceMs: 0,
				concurrency: 1,
				deps: {
					getParentStatus: async (id: string) => {
						calls.push(`parent-status:${id}`);
						return "RUNNING";
					},
					terminateParent: async (id: string) => {
						calls.push(`parent-terminate:${id}`);
						return "terminated";
					},
					waitParentClosed: async (id: string) => {
						calls.push(`parent-wait:${id}`);
						return true;
					},
					getAgentRuntimeStatus: async (runtimeAppId: string, id: string) => {
						calls.push(`child-status:${runtimeAppId}/${id}`);
						return "RUNNING";
					},
					terminateAgentRuntime: async (runtimeAppId: string, id: string) => {
						calls.push(`child-terminate:${runtimeAppId}/${id}`);
						return "terminated";
					},
					waitAgentRuntimeClosed: async (runtimeAppId: string, id: string) => {
						calls.push(`child-wait:${runtimeAppId}/${id}`);
						return true;
					},
					purgeParent: async (id: string) => {
						calls.push(`parent-purge:${id}`);
					},
					purgeAgentRuntime: async (runtimeAppId: string, id: string) => {
						calls.push(`child-purge:${runtimeAppId}/${id}`);
					},
					sleep: async () => {
						calls.push("sleep");
					},
				},
			});

		expect(result).toEqual({
			allClosed: true,
			parentClosed: true,
			agentRuntimeClosed: true,
		});
		expect(calls).toEqual([
			"parent-status:parent-1",
			"child-status:agent-session-host/session-1",
			"child-terminate:agent-session-host/session-1",
			"child-wait:agent-session-host/session-1",
			"parent-terminate:parent-1",
			"parent-wait:parent-1",
			"child-purge:agent-session-host/session-1",
			"parent-purge:parent-1",
		]);
		});

	it("requests graceful cancellation before hard termination", async () => {
		const calls: string[] = [];
		const result =
			await __benchmarkDurableRuntimeForTest.cleanupBenchmarkDurableWorkflowCascade({
				parentInstanceIds: ["parent-1"],
				agentRuntimeTargets: [
					{ runtimeAppId: "agent-session-host", instanceId: "session-1" },
				],
				reason: "operator cleanup",
				purge: true,
				purgeGraceMs: 0,
				gracefulCancellationWaitMs: 1,
				concurrency: 1,
				deps: {
					getParentStatus: async (id: string) => {
						calls.push(`parent-status:${id}`);
						return calls.includes(`parent-cancel:${id}`) ? "COMPLETED" : "RUNNING";
					},
					cancelParent: async (id: string) => {
						calls.push(`parent-cancel:${id}`);
						return "requested";
					},
					terminateParent: async () => {
						throw new Error("parent should close gracefully");
					},
					waitParentClosed: async () => {
						throw new Error("parent should not need hard terminate wait");
					},
					getAgentRuntimeStatus: async (runtimeAppId: string, id: string) => {
						calls.push(`child-status:${runtimeAppId}/${id}`);
						return calls.includes(`child-cancel:${runtimeAppId}/${id}`)
							? "COMPLETED"
							: "RUNNING";
					},
					cancelAgentRuntime: async (runtimeAppId: string, id: string) => {
						calls.push(`child-cancel:${runtimeAppId}/${id}`);
						return "requested";
					},
					terminateAgentRuntime: async () => {
						throw new Error("child should close gracefully");
					},
					waitAgentRuntimeClosed: async () => {
						throw new Error("child should not need hard terminate wait");
					},
					purgeParent: async (id: string) => {
						calls.push(`parent-purge:${id}`);
					},
					purgeAgentRuntime: async (runtimeAppId: string, id: string) => {
						calls.push(`child-purge:${runtimeAppId}/${id}`);
					},
					sleep: async () => undefined,
				},
			});

		expect(result).toEqual({
			allClosed: true,
			parentClosed: true,
			agentRuntimeClosed: true,
		});
		expect(calls).toEqual([
			"parent-status:parent-1",
			"child-status:agent-session-host/session-1",
			"child-cancel:agent-session-host/session-1",
			"child-status:agent-session-host/session-1",
			"parent-cancel:parent-1",
			"parent-status:parent-1",
			"child-purge:agent-session-host/session-1",
			"parent-purge:parent-1",
		]);
	});

	it("escalates to hard termination when graceful cancellation does not close", async () => {
		const calls: string[] = [];
		const result =
			await __benchmarkDurableRuntimeForTest.cleanupBenchmarkDurableWorkflowCascade({
				parentInstanceIds: ["parent-1"],
				agentRuntimeTargets: [
					{ runtimeAppId: "agent-session-host", instanceId: "session-1" },
				],
				reason: "operator cleanup",
				purge: false,
				purgeGraceMs: 0,
				gracefulCancellationWaitMs: 1,
				concurrency: 1,
				deps: {
					getParentStatus: async () => "RUNNING",
					cancelParent: async () => {
						calls.push("parent-cancel");
						return "requested";
					},
					terminateParent: async () => {
						calls.push("parent-terminate");
						return "terminated";
					},
					waitParentClosed: async () => {
						calls.push("parent-wait");
						return true;
					},
					getAgentRuntimeStatus: async () => "RUNNING",
					cancelAgentRuntime: async () => {
						calls.push("child-cancel");
						return "requested";
					},
					terminateAgentRuntime: async () => {
						calls.push("child-terminate");
						return "terminated";
					},
					waitAgentRuntimeClosed: async () => {
						calls.push("child-wait");
						return true;
					},
					purgeParent: async () => undefined,
					purgeAgentRuntime: async () => undefined,
					sleep: async () => undefined,
				},
			});

		expect(result).toEqual({
			allClosed: true,
			parentClosed: true,
			agentRuntimeClosed: true,
		});
		expect(calls.indexOf("child-cancel")).toBeLessThan(
			calls.indexOf("child-terminate"),
		);
		expect(calls.indexOf("parent-cancel")).toBeLessThan(
			calls.indexOf("parent-terminate"),
		);
		expect(calls).toContain("child-wait");
		expect(calls).toContain("parent-wait");
	});

	it("includes run-level coordinator workflow ids in durable state row purge", async () => {
		const calls: string[] = [];
		const result =
			await __benchmarkDurableRuntimeForTest.cleanupBenchmarkDurableWorkflowCascade({
				parentInstanceIds: ["parent-1"],
				agentRuntimeTargets: [],
				statePurgeInstanceIds: ["swebench-run-1"],
				reason: "operator cleanup",
				purge: true,
				purgeGraceMs: 0,
				concurrency: 1,
				deps: {
					getParentStatus: async (id: string) => {
						calls.push(`parent-status:${id}`);
						return "COMPLETED";
					},
					terminateParent: async () => {
						throw new Error("parent should already be terminal");
					},
					waitParentClosed: async () => {
						throw new Error("parent should already be terminal");
					},
					getAgentRuntimeStatus: async () => {
						throw new Error("child should not be inspected");
					},
					terminateAgentRuntime: async () => {
						throw new Error("child should not be terminated");
					},
					waitAgentRuntimeClosed: async () => {
						throw new Error("child should not be waited");
					},
					purgeParent: async (id: string) => {
						calls.push(`parent-purge:${id}`);
					},
					purgeAgentRuntime: async () => {
						throw new Error("child should not be purged");
					},
					purgeStateRows: async (parents, targets, extraIds) => {
						calls.push(
							`state-purge:${parents.join(",")}:${targets.length}:${extraIds?.join(",")}`,
						);
					},
					sleep: async () => {
						throw new Error("sleep should not be called");
					},
				},
			});

		expect(result).toEqual({
			allClosed: true,
			parentClosed: true,
			agentRuntimeClosed: true,
		});
		expect(calls).toEqual([
			"parent-status:parent-1",
			"parent-purge:parent-1",
			"state-purge:parent-1:0:swebench-run-1",
		]);
	});

	it("force-purges scoped state rows when terminal cleanup cannot observe Dapr closure", async () => {
		const calls: string[] = [];
		const result =
			await __benchmarkDurableRuntimeForTest.cleanupBenchmarkDurableWorkflowCascade({
				parentInstanceIds: ["parent-1"],
				agentRuntimeTargets: [
					{ runtimeAppId: "agent-session-host", instanceId: "session-1" },
				],
				statePurgeInstanceIds: ["swebench-run-1"],
				reason: "terminal benchmark cleanup",
				purge: true,
				purgeGraceMs: 0,
				forceStatePurgeOnUnclosed: true,
				concurrency: 1,
				deps: {
					getParentStatus: async (id: string) => {
						calls.push(`parent-status:${id}`);
						return "RUNNING";
					},
					terminateParent: async (id: string) => {
						calls.push(`parent-terminate:${id}`);
						return "terminated";
					},
					waitParentClosed: async (id: string) => {
						calls.push(`parent-wait:${id}`);
						return false;
					},
					getAgentRuntimeStatus: async (runtimeAppId: string, id: string) => {
						calls.push(`child-status:${runtimeAppId}/${id}`);
						return "RUNNING";
					},
					terminateAgentRuntime: async (runtimeAppId: string, id: string) => {
						calls.push(`child-terminate:${runtimeAppId}/${id}`);
						return "terminated";
					},
					waitAgentRuntimeClosed: async (runtimeAppId: string, id: string) => {
						calls.push(`child-wait:${runtimeAppId}/${id}`);
						return true;
					},
					purgeParent: async (id: string) => {
						calls.push(`parent-purge:${id}`);
					},
					purgeAgentRuntime: async (runtimeAppId: string, id: string) => {
						calls.push(`child-purge:${runtimeAppId}/${id}`);
					},
					purgeStateRows: async (parents, targets, extraIds) => {
						const targetIds = targets
							.map((target) => target.instanceId)
							.join(",");
						calls.push(
							`state-purge:${parents.join(",")}:${targetIds}:${extraIds?.join(",")}`,
						);
					},
					sleep: async () => {
						calls.push("sleep");
					},
				},
			});

		expect(result).toEqual({
			allClosed: true,
			parentClosed: true,
			agentRuntimeClosed: true,
		});
		expect(calls).toEqual([
			"parent-status:parent-1",
			"child-status:agent-session-host/session-1",
			"child-terminate:agent-session-host/session-1",
			"child-wait:agent-session-host/session-1",
			"parent-terminate:parent-1",
			"parent-wait:parent-1",
			"parent-status:parent-1",
			"parent-terminate:parent-1",
			"parent-wait:parent-1",
			"state-purge:parent-1:session-1:swebench-run-1",
		]);
		expect(calls).not.toContain("parent-purge:parent-1");
		expect(calls).not.toContain("child-purge:agent-session-host/session-1");
	});

	it("includes the recorded session runtime app id in durable cleanup targets", () => {
		expect(
			benchmarkAgentRuntimeCleanupRuntimeAppIds({
				runRuntimeAppId: "agent-runtime-pool-coding",
				sessionRuntimeAppId: "dapr-agent-py",
				sessionId: "session-1",
				runSummary: {
					execution: {
						backend: "dapr-kueue",
					},
				},
			}),
		).toEqual([
			"agent-runtime-pool-coding",
			"dapr-agent-py",
			benchmarkSessionHostAppId("session-1"),
		]);
	});

	it("purges benchmark Dapr histories by default", () => {
		expect(
			__benchmarkDurableRuntimeForTest.shouldPurgeBenchmarkDaprWorkflowsOnCleanup(),
		).toBe(true);
	});

	it("does not advance stalled benchmark cleanup after durable close confirmation times out by default", () => {
		expect(
			__benchmarkDurableRuntimeForTest.shouldProceedAfterStalledDurableCleanupTimeout(),
		).toBe(false);
		expect(
			__benchmarkDurableRuntimeForTest.terminalRunShouldProceedAfterDurableCleanupTimeout(
				"cancelled",
			),
		).toBe(false);
		expect(
			__benchmarkDurableRuntimeForTest.terminalRunShouldProceedAfterDurableCleanupTimeout(
				"failed",
			),
		).toBe(false);
		vi.stubEnv(
			"BENCHMARK_PROCEED_AFTER_STALLED_DURABLE_CLEANUP_TIMEOUT",
			"false",
		);
		expect(
			__benchmarkDurableRuntimeForTest.shouldProceedAfterStalledDurableCleanupTimeout(),
		).toBe(false);
		expect(
			__benchmarkDurableRuntimeForTest.terminalRunShouldProceedAfterDurableCleanupTimeout(
				"cancelled",
			),
		).toBe(false);
		vi.stubEnv(
			"BENCHMARK_PROCEED_AFTER_STALLED_DURABLE_CLEANUP_TIMEOUT",
			"true",
		);
		expect(
			__benchmarkDurableRuntimeForTest.shouldProceedAfterStalledDurableCleanupTimeout(),
		).toBe(true);
		expect(
			__benchmarkDurableRuntimeForTest.terminalRunShouldProceedAfterDurableCleanupTimeout(
				"cancelled",
			),
		).toBe(true);
	});

	it("does not purge multi-app child workflow parents that fail to close", async () => {
		const calls: string[] = [];
		const result =
			await __benchmarkDurableRuntimeForTest.cleanupBenchmarkDurableWorkflowCascade({
				parentInstanceIds: ["parent-1"],
				agentRuntimeTargets: [
					{ runtimeAppId: "agent-session-host", instanceId: "session-1" },
				],
				reason: "operator cleanup",
				purge: true,
				purgeGraceMs: 0,
				concurrency: 1,
				deps: {
					getParentStatus: async () => "RUNNING",
					terminateParent: async () => {
						calls.push("parent-terminate");
						return "terminated";
					},
					waitParentClosed: async () => {
						calls.push("parent-wait");
						return false;
					},
					getAgentRuntimeStatus: async () => "RUNNING",
					terminateAgentRuntime: async () => {
						calls.push("child-terminate");
						return "terminated";
					},
					waitAgentRuntimeClosed: async () => {
						calls.push("child-wait");
						return true;
					},
					purgeParent: async () => {
						calls.push("parent-purge");
					},
					purgeAgentRuntime: async () => {
						calls.push("child-purge");
					},
					sleep: async () => {
						calls.push("sleep");
					},
				},
			});

		expect(result.allClosed).toBe(false);
		expect(result.parentClosed).toBe(false);
		expect(calls).toEqual([
			"child-terminate",
			"child-wait",
			"parent-terminate",
			"parent-wait",
			"parent-terminate",
			"parent-wait",
		]);
		});

	it("still terminates parent-only workflows when no child runtime targets exist", async () => {
		const calls: string[] = [];
		const result =
			await __benchmarkDurableRuntimeForTest.cleanupBenchmarkDurableWorkflowCascade({
				parentInstanceIds: ["parent-1"],
				agentRuntimeTargets: [],
				reason: "operator cleanup",
				purge: false,
				purgeGraceMs: 0,
				concurrency: 1,
				deps: {
					getParentStatus: async () => "RUNNING",
					terminateParent: async () => {
						calls.push("parent-terminate");
						return "terminated";
					},
					waitParentClosed: async () => {
						calls.push("parent-wait");
						return true;
					},
					getAgentRuntimeStatus: async () => {
						throw new Error("child should not be inspected");
					},
					terminateAgentRuntime: async () => {
						throw new Error("child should not be terminated");
					},
					waitAgentRuntimeClosed: async () => {
						throw new Error("child should not be waited");
					},
					purgeParent: async () => undefined,
					purgeAgentRuntime: async () => undefined,
					sleep: async () => undefined,
				},
			});

		expect(result).toEqual({
			allClosed: true,
			parentClosed: true,
			agentRuntimeClosed: true,
		});
		expect(calls).toEqual(["parent-terminate", "parent-wait"]);
	});

	it("treats missing child/session-host workflows as already closed", async () => {
		const calls: string[] = [];
		const result =
			await __benchmarkDurableRuntimeForTest.cleanupBenchmarkDurableWorkflowCascade({
				parentInstanceIds: ["parent-1"],
				agentRuntimeTargets: [
					{ runtimeAppId: "agent-session-host", instanceId: "missing-session" },
				],
				reason: "operator cleanup",
				purge: false,
				purgeGraceMs: 0,
				concurrency: 1,
				deps: {
					getParentStatus: async () => "TERMINATED",
					terminateParent: async () => {
						throw new Error("parent should not be terminated");
					},
					waitParentClosed: async () => true,
					getAgentRuntimeStatus: async () => "__missing__",
					terminateAgentRuntime: async () => {
						throw new Error("child should not be terminated");
					},
					waitAgentRuntimeClosed: async () => {
						calls.push("child-wait");
						return false;
					},
					purgeParent: async () => undefined,
					purgeAgentRuntime: async () => undefined,
					sleep: async () => undefined,
				},
			});

		expect(result.allClosed).toBe(true);
		expect(calls).toEqual([]);
	});

	it("extracts max-iteration stop reasons from session metrics", () => {
		expect(
			extractAgentStopReason(
				[{ termination_reason: "max_iters" }],
				1,
			),
		).toContain("maxTurns=1");
	});

	it("keeps cancellation sandbox cleanup scoped to benchmark-owned OpenShell names", () => {
		const runId = "codexcap20x20260504014703";
		const names =
			__benchmarkSandboxCleanupForTest.collectBenchmarkSandboxNamesFromValues([
				{
					outputs: {
						workspace_profile: {
							workspaceRef:
								"swebench-1234567890-codexcap20x20260504014703",
							sandboxName:
								"swebench-1234567890-codexcap20x20260504014703",
						},
					},
				},
				{ sandboxName: "dapr-agent-py" },
				{ sandbox_name: "agent-runtime-pool-coding" },
				{
					runtimeSandboxName:
						"swebench-abcdef1234-codexcap20x20260504014703",
				},
				{
					runtime_sandbox_name:
						"swebench-abcdef5678-codexcap20x20260504014703",
				},
				{ workspaceSandboxName: "manual-debug-sandbox" },
			]);

		expect(names).toContain("swebench-1234567890-codexcap20x20260504014703");
		expect(names).toContain("swebench-abcdef1234-codexcap20x20260504014703");
		expect(names).toContain("swebench-abcdef5678-codexcap20x20260504014703");
		expect(
			__benchmarkSandboxCleanupForTest.shouldDeleteBenchmarkSandboxName(
				runId,
				"swebench-1234567890-codexcap20x20260504014703",
			),
		).toBe(true);
		expect(
			__benchmarkSandboxCleanupForTest.shouldDeleteBenchmarkSandboxName(
				runId,
				"dapr-agent-py",
			),
		).toBe(false);
		expect(
			__benchmarkSandboxCleanupForTest.shouldDeleteBenchmarkSandboxName(
				runId,
				"agent-runtime-pool-coding",
			),
		).toBe(false);
		expect(
			__benchmarkSandboxCleanupForTest.shouldDeleteBenchmarkSandboxName(
				runId,
				"manual-debug-sandbox",
			),
		).toBe(false);
		expect(
			__benchmarkSandboxCleanupForTest.isOpenShellSandboxNotFound(
				'Error: status: NotFound, message: "sandbox not found"',
			),
		).toBe(true);
	});

	it("includes labeled Sandbox CRs in host execution cleanup targets", () => {
		const targets =
			__benchmarkSandboxCleanupForTest.hostSandboxExecutionResourceTargetsForTest(
				"workflow-builder",
				"benchmark-run-id=run-1",
			);
		const sandboxTarget = targets.find((target) => target.kind === "sandbox");

		expect(sandboxTarget?.listPath).toBe(
			"/apis/agents.x-k8s.io/v1alpha1/namespaces/workflow-builder/sandboxes?labelSelector=benchmark-run-id%3Drun-1",
		);
		expect(sandboxTarget?.itemPath("swebench-abc-run-1")).toBe(
			"/apis/agents.x-k8s.io/v1alpha1/namespaces/workflow-builder/sandboxes/swebench-abc-run-1",
		);
		expect(sandboxTarget?.shouldDelete?.("swebench-abc-run-1")).toBe(true);
		expect(
			sandboxTarget?.shouldDelete?.(
				"agent-host-agent-session-84878d7810889fb79a9d",
			),
		).toBe(true);
		expect(sandboxTarget?.shouldDelete?.("manual-debug-sandbox")).toBe(false);
		expect(
			__benchmarkSandboxCleanupForTest.shouldDeleteBenchmarkSandboxName(
				"run-1",
				"agent-host-agent-session-84878d7810889fb79a9d",
			),
		).toBe(false);
	});

	it("keeps host execution resources after successful instance inference", () => {
		expect(
			__benchmarkSandboxCleanupForTest.benchmarkInstanceCleanupDeletesHostExecutionResources(
				{ completedInference: true },
			),
		).toBe(false);
		expect(
			__benchmarkSandboxCleanupForTest.benchmarkInstanceCleanupDeletesHostExecutionResources(
				{ completedInference: false },
			),
		).toBe(true);
	});

	it("scopes live OpenShell pod discovery to the benchmark run", () => {
		const runId = "1AZ8GqVDZgzekfnwHmsur";
		const names =
			__benchmarkSandboxCleanupForTest.collectOpenShellSandboxNamesFromKubeItems(
				runId,
				[
					{ metadata: { name: "swebench-422bf07c90-1az8gqvdzg" } },
					{ metadata: { name: "workspace-swebench-422bf07c90-1az8gqvdzg" } },
					{ metadata: { name: "swebench-9266607f0c-otherun123" } },
					{ metadata: { name: "agent-runtime-pool-coding" } },
					{ metadata: { name: "dapr-agent-py" } },
					{ metadata: { name: "manual-debug-sandbox" } },
				],
			);

		expect(names).toEqual(["swebench-422bf07c90-1az8gqvdzg"]);
		expect(
			__benchmarkSandboxCleanupForTest.matchesBenchmarkRunSandboxName(
				runId,
				"swebench-422bf07c90-1az8gqvdzg",
			),
		).toBe(true);
		expect(
			__benchmarkSandboxCleanupForTest.matchesBenchmarkRunSandboxName(
				runId,
				"swebench-9266607f0c-otherun123",
			),
		).toBe(false);
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

	it("terminates completed-run session projections only after workflow closure", () => {
		expect(
			shouldTerminateCompletedBenchmarkSessionProjection({
				sessionStatus: "running",
				executionStatus: "success",
				executionPhase: "completed",
				instanceStatus: "failed",
			}),
		).toBe(true);
		expect(
			shouldTerminateCompletedBenchmarkSessionProjection({
				sessionStatus: "rescheduling",
				executionStatus: "error",
				executionPhase: "failed",
				instanceStatus: "error",
			}),
		).toBe(true);
		expect(
			shouldTerminateCompletedBenchmarkSessionProjection({
				sessionStatus: "running",
				executionStatus: "running",
				executionPhase: "running",
				instanceStatus: "failed",
			}),
		).toBe(false);
		expect(
			shouldTerminateCompletedBenchmarkSessionProjection({
				sessionStatus: "terminated",
				executionStatus: "success",
				executionPhase: "completed",
				instanceStatus: "resolved",
			}),
		).toBe(false);
		expect(
			shouldTerminateCompletedBenchmarkSessionProjection({
				sessionStatus: "running",
				executionStatus: null,
				executionPhase: null,
				instanceStatus: "resolved",
			}),
		).toBe(true);
	});

	it("requires completed-run durable cleanup when Dapr targets exist even if projections are terminal", () => {
		expect(
			completedBenchmarkRunHasDurableWorkflowTarget({
				executionDaprId: "sw-swebench-instance-exec-abc",
				sessionId: null,
			}),
		).toBe(true);
		expect(
			completedBenchmarkRunHasDurableWorkflowTarget({
				runInstanceSessionId: "sw-swebench-instance-exec-abc__durable__solve__run__0",
				sessionId: null,
			}),
		).toBe(true);
		expect(
			completedBenchmarkRunHasDurableWorkflowTarget({
				runInstanceDaprId: null,
				executionDaprId: null,
				runInstanceSessionId: null,
				sessionId: null,
			}),
		).toBe(false);
	});

	it("does not finalize failed instances, sandboxes, or leases before durable workflows close", async () => {
		const calls: string[] = [];
		const hooks = {
			finalizeInstances: vi.fn(async () => {
				calls.push("instances");
			}),
			cleanupSandboxes: vi.fn(async () => {
				calls.push("sandboxes");
			}),
			releaseLeases: vi.fn(async () => {
				calls.push("leases");
			}),
			warn: vi.fn(() => {
				calls.push("warn");
			}),
		};

		await expect(
			cleanupBenchmarkTerminalResourcesAfterDurableClosure(
				{
					runId: "run_1",
					outcome: "failed",
					reason: "benchmark run failed",
					now,
					workflowsClosed: false,
				},
				hooks,
			),
		).resolves.toBe(false);

		expect(calls).toEqual(["warn"]);
		expect(hooks.finalizeInstances).not.toHaveBeenCalled();
		expect(hooks.cleanupSandboxes).not.toHaveBeenCalled();
		expect(hooks.releaseLeases).not.toHaveBeenCalled();
	});

	it("does not finalize cancelled-run resources before durable workflows close", async () => {
		const calls: string[] = [];
		const hooks = {
			finalizeInstances: vi.fn(async () => {
				calls.push("instances");
			}),
			cleanupSandboxes: vi.fn(async () => {
				calls.push("sandboxes");
			}),
			releaseLeases: vi.fn(async () => {
				calls.push("leases");
			}),
			warn: vi.fn(() => {
				calls.push("warn");
			}),
		};

		await expect(
			cleanupBenchmarkTerminalResourcesAfterDurableClosure(
				{
					runId: "run_1",
					outcome: "cancelled",
					reason: "benchmark run cancelled",
					now,
					workflowsClosed: false,
				},
				hooks,
			),
		).resolves.toBe(false);

		expect(calls).toEqual(["warn"]);
		expect(hooks.finalizeInstances).not.toHaveBeenCalled();
		expect(hooks.cleanupSandboxes).not.toHaveBeenCalled();
		expect(hooks.releaseLeases).not.toHaveBeenCalled();
	});

	it("does not run any cancelled-run cleanup fallback after an earlier cleanup", async () => {
		const calls: string[] = [];
		const hooks = {
			finalizeInstances: vi.fn(async () => {
				calls.push("instances");
			}),
			cleanupSandboxes: vi.fn(async () => {
				calls.push("sandboxes");
			}),
			releaseLeases: vi.fn(async () => {
				calls.push("leases");
			}),
			warn: vi.fn(() => {
				calls.push("warn");
			}),
		};

		await expect(
			cleanupBenchmarkTerminalResourcesAfterDurableClosure(
				{
					runId: "run_1",
					outcome: "cancelled",
					reason: "benchmark run cancelled",
					now,
					workflowsClosed: false,
					resourcesAlreadyCleaned: true,
				},
				hooks,
			),
		).resolves.toBe(false);

		expect(calls).toEqual(["warn"]);
		expect(hooks.finalizeInstances).not.toHaveBeenCalled();
		expect(hooks.cleanupSandboxes).not.toHaveBeenCalled();
		expect(hooks.releaseLeases).not.toHaveBeenCalled();
	});

	it("finalizes terminal resources after durable workflows close", async () => {
		const calls: string[] = [];
		const hooks = {
			finalizeInstances: vi.fn(async () => {
				calls.push("instances");
			}),
			cleanupSandboxes: vi.fn(async () => {
				calls.push("sandboxes");
			}),
			releaseLeases: vi.fn(async () => {
				calls.push("leases");
			}),
			warn: vi.fn(() => {
				calls.push("warn");
			}),
		};

		await expect(
			cleanupBenchmarkTerminalResourcesAfterDurableClosure(
				{
					runId: "run_1",
					outcome: "cancelled",
					reason: "benchmark run cancelled",
					now,
					workflowsClosed: true,
				},
				hooks,
			),
		).resolves.toBe(true);

		expect(calls).toEqual(["instances", "sandboxes", "leases"]);
	});
});

describe("buildSwebenchInstanceScript (P3 producer port)", () => {
	it("re-expresses the SW spine as a script with the agent bound to the profile sandbox", () => {
		const params = {
			runId: "run_1",
			suiteSlug: "SWE-bench_Lite" as const,
			datasetName: "princeton-nlp/SWE-bench_Lite",
			instanceId: "sympy__sympy-20590",
			repo: "sympy/sympy",
			baseCommit: "abc123",
			problemStatement: "Fix it",
			hintsText: null,
			testMetadata: { version: "1.7" },
			agentId: "agent_1",
			agentVersion: 1,
			timeoutSeconds: 7200,
			maxTurns: null,
			inferenceEnvironment: validatedInferenceEnvironment(),
		};
		const spec = buildSwebenchInstanceWorkflowSpec(params) as {
			do: Array<Record<string, unknown>>;
		};
		const { script, meta, scriptSha256 } = buildSwebenchInstanceScript(params);

		expect(meta.name).toBe("swebench-instance");
		expect(scriptSha256).toMatch(/^[0-9a-f]{64}$/);
		// Same 4-step spine as the SW spec.
		expect(spec.do.length).toBe(4);
		expect(script).toContain("action('workspace/profile'");
		expect(script).toContain("label: 'checkout_repo'");
		expect(script).toContain("agent: \"agent_1\"");
		expect(script).toContain("agentVersion: 1");
		expect(script).toContain("workspaceRef: profile?.workspaceRef");
		expect(script).toContain("sandboxName: profile?.sandboxName");
		expect(script).toContain("label: 'extract_patch'");
		// The graders read modelPatch off the returnValue.
		expect(script).toContain("modelPatch,");
		expect(script).toContain("instanceId: \"sympy__sympy-20590\"");
	});
});

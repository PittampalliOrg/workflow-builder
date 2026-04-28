import { describe, expect, it } from "vitest";
import {
	buildSwebenchInstanceWorkflowGraph,
	buildSwebenchInstanceWorkflowSpec,
	collectBenchmarkTraceIds,
	extractBenchmarkRuntimeLinks,
	resolveBenchmarkInferenceStatus,
	resolveBenchmarkInstanceStatusAfterInference,
} from "./service";

describe("SWE-bench workflow spec", () => {
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
		expect(extractPatch.with.command).toBe(
			"set -eu\ncd /sandbox/repo\nrm -rf /sandbox/.cache .cache\ngit diff --binary 'cffd4e0f86fefd4802349a9f9b19ed70934ea354' --",
		);
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
				validationCommand: "PYTHONPATH=src python -m pytest --version",
			},
		});
		const solve = (spec.do as Array<Record<string, { with: { body: { prompt: string } } }>>)[3]
			.solve;
		expect(solve.with.body.prompt).toContain(".prepare_environment.promptNotes");
		expect(solve.with.body).toMatchObject({
			environmentConfig: {
				swebenchInferenceEnvironment: "${ .prepare_environment.environment }",
			},
		});
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
		expect(workspaceProfile.with.sandboxTemplate).toBe(
			'${ .prepare_environment.sandboxTemplate // "dapr-agent" }',
		);
		expect(workspaceProfile.with.sandboxImage).toBe(
			"${ .prepare_environment.sandboxImage }",
		);
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

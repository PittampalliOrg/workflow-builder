import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildAgentEvaluationWorkflowSpec,
	buildCodeEvalDefaultGraders,
	buildSwebenchEvaluationWorkflowSpec,
	collectEvaluationTraceIds,
	detectCodeEvalInfrastructureFailure,
	extractEvaluationGeneratedOutput,
	extractSwebenchModelPatch,
	normalizeCodeEvalRowForEvaluation,
	parseDatasetImport,
	prepareEvaluationWorkflowTriggerData,
} from "./service";

describe("evaluation dataset import", () => {
	it("parses JSONL rows", () => {
		const rows = parseDatasetImport(
			'{"id":"row-1","input":{"prompt":"A"},"expectedOutput":"B"}\n{"id":"row-2","answer":"D"}\n',
			"jsonl",
		);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ id: "row-1" });
	});

	it("parses CSV rows with quoted fields", () => {
		const rows = parseDatasetImport(
			'id,prompt,expectedOutput\nrow-1,"hello, world",ok\n',
			"csv",
		);
		expect(rows).toEqual([
			{ id: "row-1", prompt: "hello, world", expectedOutput: "ok" },
		]);
	});

	it("wraps a single JSON object as one row", () => {
		const rows = parseDatasetImport('{"id":"row-1","output":"ok"}', "json");
		expect(rows).toEqual([{ id: "row-1", output: "ok" }]);
	});
});

describe("evaluation agent workflow", () => {
	it("renders a durable/run workflow from a prompt template", () => {
		const spec = buildAgentEvaluationWorkflowSpec({
			evaluationName: "Answer quality",
			agentId: "agent_1",
			agentVersion: 2,
			input: { prompt: "What is 2+2?", locale: "en" },
			taskConfig: { promptTemplate: "{{input.prompt}}\nLocale: {{input.locale}}" },
		});
		const step = (spec.do as Array<Record<string, { call: string; with: { body: { prompt: string; agentRef: { version: number } } } }>>)[0]
			.evaluate;
		expect(step.call).toBe("durable/run");
		expect(step.with.body.prompt).toContain("What is 2+2?");
		expect(step.with.body.agentRef.version).toBe(2);
	});

	it("builds workflow trigger data with row fields and evaluation metadata", async () => {
		const triggerData = await prepareEvaluationWorkflowTriggerData({
			spec: {
				document: {
					dsl: "1.0.0",
					namespace: "tests",
					name: "workflow-eval",
					"x-workflow-builder": {
						input: {
							fields: {
								locale: { defaultValue: "en" },
							},
						},
					},
				},
				do: [
					{
						step: {
							with: {
								body: {
									prompt: "${ .trigger.prompt }",
									locale: "${ .trigger.locale }",
								},
							},
						},
					},
				],
			},
			runId: "run_1",
			itemId: "item_1",
			datasetRowId: "row_1",
			input: { prompt: "What is 2+2?" },
			expectedOutput: "4",
		});

		expect(triggerData).toMatchObject({
			prompt: "What is 2+2?",
			locale: "en",
			evaluation: {
				runId: "run_1",
				itemId: "item_1",
				datasetRowId: "row_1",
				input: { prompt: "What is 2+2?" },
				expectedOutput: "4",
			},
		});
	});

	it("renders a SWE-bench workflow that captures a model patch", () => {
		const spec = buildSwebenchEvaluationWorkflowSpec({
			evaluationName: "SWE-bench Lite",
			runId: "eval_run",
			itemId: "item_1",
			agentId: "agent_1",
			agentVersion: 3,
			input: {
				instanceId: "django__django-12345",
				repo: "django/django",
				baseCommit: "abc123",
				problemStatement: "Fix the failing test.",
				testMetadata: {
					version: "3.2",
					test_patch: "diff --git a/tests/test_fix.py b/tests/test_fix.py\n",
					FAIL_TO_PASS: ["tests/test_fix.py::test_regression"],
					PASS_TO_PASS: ["tests/test_existing.py::test_existing"],
				},
			},
			taskConfig: {
				adapter: "swebench",
				datasetName: "princeton-nlp/SWE-bench_Lite",
			},
			executionConfig: { timeoutSeconds: 3600, maxTurns: 25 },
			inferenceEnvironment: {
				environmentStatus: "validated",
				suite: "SWE-bench_Lite",
				repo: "django/django",
				version: "3.2",
				environmentKey: "django-3.2",
				sandboxTemplate: "dapr-agent",
				sandboxImage:
					"ghcr.io/pittampalliorg/swebench-inference-django-3.2:git-abc@sha256:1111111111111111111111111111111111111111111111111111111111111111",
				buildStrategy: "swebench-harness",
				workspaceRoot: "/testbed",
				validationCommand: "cd /testbed && python --version",
				environmentNotes: [
					"The repository is already prepared under /testbed at the SWE-bench base commit.",
				],
				swebenchSpec: {
					workspaceRoot: "/testbed",
				},
			},
		});
		const steps = spec.do as Array<Record<string, Record<string, unknown>>>;
		expect(steps.map((step) => Object.keys(step)[0])).toEqual([
			"workspace_profile",
			"checkout_repo",
			"solve",
			"extract_patch",
		]);
		const solve = steps[2].solve as {
			call: string;
			with: {
				body: {
					agentRef: { version: number };
					overrides: { tools: string[] };
					prompt: string;
				};
			};
		};
		expect(solve.call).toBe("durable/run");
		expect(solve.with.body.agentRef.version).toBe(3);
		expect(solve.with.body.overrides.tools).toEqual([
			"execute_command",
			"read_file",
			"write_file",
			"edit_file",
			"list_files",
			"glob_files",
			"grep_search",
		]);
		const workspaceProfile = steps[0].workspace_profile as { with: { workspaceRef: string } };
		expect(workspaceProfile.with.workspaceRef).toBe(
			"eval-swebench-c2a85f01af-eval-run-item-1-django-django-12345",
		);
		expect(solve.with.body.prompt).toContain("Do not use web search");
		expect(solve.with.body.prompt).toContain("Work only in /sandbox/repo");
		expect(JSON.stringify(solve.with.body)).toContain("generic eval path only captures the patch");
		expect(JSON.stringify(solve.with.body)).not.toContain("python3.12");
		const extractPatch = steps[3].extract_patch as { with: { command: string } };
		expect(extractPatch.with.command).toContain("rm -rf /sandbox/.cache .cache");
		expect(extractPatch.with.command).toContain("cd '/sandbox/repo'");
		expect(JSON.stringify(spec.output)).toContain("modelPatch");
		const serialized = JSON.stringify(spec);
		expect(serialized).not.toContain("/testbed");
		expect(serialized).not.toContain("test_patch");
		expect(serialized).not.toContain("FAIL_TO_PASS");
		expect(serialized).not.toContain("PASS_TO_PASS");
	});
});

describe("code-eval template normalization", () => {
	it.each([
		["humaneval-plus", { task_id: "HumanEval/0", entry_point: "add_one" }],
		["mbpp-plus", { task_id: "2", code: "def add_one(x):\n    return x + 1\n" }],
	] as const)("wraps %s check(candidate) tests for pytest discovery", (suiteSlug, rowBase) => {
		const row = normalizeCodeEvalRowForEvaluation({
			suiteSlug,
			index: 0,
			row: {
				...rowBase,
				prompt: "Write add_one.",
				test: "def check(candidate):\n    assert candidate(1) == 2\n",
			},
		});
		const content = codeEvalTestFileContent(row);

		expect(content).toContain(
			'_wb_solution_path = _wb_Path(_wb_os.environ.get("CODE_EVAL_SOLUTION_PATH") or "/sandbox/solution.py")',
		);
		expect(content).toContain(
			'_wb_spec = _wb_importlib_util.spec_from_file_location("solution", _wb_solution_path)',
		);
		expect(content).toContain("_wb_sys.modules[_wb_spec.name] = _wb_solution");
		expect(content).toContain('_wb_entry_point = "add_one"');
		expect(content).toContain("candidate = getattr(_wb_solution, _wb_entry_point)");
		expect(content).toContain("globals()[_wb_entry_point] = candidate");
		expect(content).not.toContain("_wb_target_globals");
		expect(content).not.toContain("vars(_wb_solution).items()");
		expect(content).toContain("def check(candidate):");
		expect(content).toContain("def test_evalplus_check():");
		expect(content).toContain("    check(candidate)");
		expect(content).not.toContain("def test_code_eval_script_executed():");
		expect((row.input as { solvePrompt: string }).solvePrompt).toContain(
			"/sandbox/.venv/bin/python -m pytest -q --tb=short --noconftest test_solution.py",
		);
		expect((row.input as { solvePrompt: string }).solvePrompt).toContain(
			"Write only /sandbox/solution.py",
		);
		expect((row.input as { solvePrompt: string }).solvePrompt).toContain(
			"Do not run pip install",
		);
		expect((row.input as { solvePrompt: string }).solvePrompt).toContain(
			"Benchmark mode forbids runtime package installation",
		);
		expect((row.input as { solvePrompt: string }).solvePrompt).not.toContain(
			"unless explicitly debugging",
		);
		expect((row.input as { sandboxTemplate: string }).sandboxTemplate).toBe(
			"code-eval-evalplus",
		);
		expect(row.expectedOutput).toEqual(
			expect.objectContaining({ testFileSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
		);
	});

	it("adds a pytest sentinel for MBPP+ top-level assertion scripts", () => {
		const row = normalizeCodeEvalRowForEvaluation({
			suiteSlug: "mbpp-plus",
			index: 0,
			row: {
				task_id: 2,
				code: "def similar_elements(test_tup1, test_tup2):\n    return tuple(set(test_tup1) & set(test_tup2))\n",
				prompt: "Write a function to find shared elements.",
				test: "assert set(similar_elements((3, 4), (4, 5))) == {4}\n",
			},
		});
		const content = codeEvalTestFileContent(row);

		expect(row.externalId).toBe("2");
		expect(content).toContain('_wb_entry_point = "similar_elements"');
		expect(content).toContain("assert set(similar_elements((3, 4), (4, 5))) == {4}");
		expect(content).toContain("def test_code_eval_script_executed():");
		expect(content).not.toContain("def test_evalplus_check():");
	});

	it("preserves MBPP+ audit metadata", () => {
		const row = normalizeCodeEvalRowForEvaluation({
			suiteSlug: "mbpp-plus",
			index: 0,
			row: {
				task_id: 2,
				code: "def add_one(x):\n    return x + 1\n",
				prompt: "Write add_one.",
				test: "def check(candidate):\n    assert candidate(1) == 2\n",
				test_list: ["assert add_one(1) == 2"],
				test_imports: ["import math"],
			},
		});

		expect(row.metadata).toMatchObject({
			protocolMode: "internal-agent-visible-tests",
			benchmarkComparable: false,
			evalplus: {
				testList: ["assert add_one(1) == 2"],
				testImports: ["import math"],
				code: "def add_one(x):\n    return x + 1",
			},
		});
	});

	it("uses BigCodeBench instruct prompts and preserves protocol metadata", () => {
		const originalTest = [
			"import unittest",
			"",
			"class TestCases(unittest.TestCase):",
			"    def test_default(self):",
			"        self.assertEqual(task_func(), 1)",
		].join("\n");
		const row = normalizeCodeEvalRowForEvaluation({
			suiteSlug: "bigcodebench",
			index: 0,
			row: {
				task_id: "BigCodeBench/0",
				complete_prompt: "def task_func():\n    pass\n",
				instruct_prompt: "Write task_func using pandas.",
				code_prompt: "def task_func():\n",
				entry_point: "task_func",
				libs: ["pandas", "networkx"],
				canonical_solution: "def task_func():\n    return 1\n",
				split: "complete",
				subset: "hard",
				test: originalTest,
			},
		});
		const content = codeEvalTestFileContent(row);

		expect((row.input as { prompt: string }).prompt).toBe("Write task_func using pandas.");
		expect((row.input as { runtimeProbeCommand: string }).runtimeProbeCommand).toContain(
			"importlib.import_module('pytest')",
		);
		expect((row.input as { runtimeProbeCommand: string }).runtimeProbeCommand).toContain(
			'libs = ["pandas","networkx"]',
		);
		expect((row.input as { sandboxTemplate: string }).sandboxTemplate).toBe(
			"code-eval-bigcodebench",
		);
		expect(row.metadata).toMatchObject({
			protocolMode: "internal-agent-visible-tests",
			benchmarkComparable: false,
			sandboxTemplate: "code-eval-bigcodebench",
			promptSource: "instruct_prompt",
			testHarness: "bigcodebench-shared-module-globals",
			testHarnessVersion: 2,
			bigcodebench: {
				split: "complete",
				subset: "hard",
				libs: ["pandas", "networkx"],
				completePrompt: "def task_func():\n    pass",
				instructPrompt: "Write task_func using pandas.",
				codePrompt: "def task_func():",
				canonicalSolution: "def task_func():\n    return 1",
			},
		});
		expect(content).toContain('_wb_entry_point = "task_func"');
		expect(content).toContain("_wb_target_globals = globals()");
		expect(content).toContain("for _wb_name, _wb_value in vars(_wb_solution).items():");
		expect(content).toContain(
			'if not (_wb_name.startswith("__") and _wb_name.endswith("__")):',
		);
		expect(content).toContain(originalTest);
		expect(content).not.toContain("def test_evalplus_check():");
		expect(content).not.toContain("def test_code_eval_script_executed():");
	});

	it("runs BigCodeBench tests that reference solution module import aliases", () => {
		const row = normalizeCodeEvalRowForEvaluation({
			suiteSlug: "bigcodebench",
			index: 180,
			row: {
				task_id: "BigCodeBench/180",
				instruct_prompt: "Use os and matplotlib-style plotting helpers.",
				code_prompt: [
					"import os",
					"import matplotlib.pyplot as plt",
					"",
					"def task_func(path):",
					"    pass",
				].join("\n"),
				entry_point: "task_func",
				libs: ["matplotlib"],
				test: [
					"import unittest",
					"",
					"class TestCases(unittest.TestCase):",
					"    def test_solution_import_aliases_are_visible(self):",
					'        self.assertEqual(os.path.basename("/tmp/example.txt"), "example.txt")',
					'        self.assertEqual(plt.__name__, "matplotlib.pyplot")',
					'        self.assertEqual(task_func("/tmp/example.txt"), "example.txt")',
				].join("\n"),
			},
		});
		const dir = mkdtempSync(join(tmpdir(), "bigcodebench-harness-"));
		try {
			const solutionPath = join(dir, "solution.py");
			writeFileSync(
				solutionPath,
				[
					"import os",
					"import types",
					'plt = types.SimpleNamespace(__name__="matplotlib.pyplot")',
					"",
					"def task_func(path):",
					"    return os.path.basename(path)",
					"",
				].join("\n"),
			);
			writeFileSync(join(dir, "test_solution.py"), codeEvalTestFileContent(row));

			const result = spawnSync("python3", ["-m", "unittest", "-q", "test_solution"], {
				cwd: dir,
				env: {
					...process.env,
					CODE_EVAL_SOLUTION_PATH: solutionPath,
				},
				encoding: "utf8",
			});

			expect(`${result.stdout}${result.stderr}`).not.toContain("NameError");
			expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
		} finally {
			rmSync(dir, { force: true, recursive: true });
		}
	});

	it("parses BigCodeBench stringified libs into importable module names", () => {
		const row = normalizeCodeEvalRowForEvaluation({
			suiteSlug: "bigcodebench",
			index: 0,
			row: {
				task_id: "BigCodeBench/38",
				instruct_prompt: "Use pandas, matplotlib, and sklearn.",
				entry_point: "task_func",
				libs: "['pandas', 'matplotlib', 'sklearn']",
				test: [
					"import unittest",
					"class TestCases(unittest.TestCase):",
					"    def test_default(self):",
					"        self.assertEqual(task_func(), 1)",
				].join("\n"),
			},
		});

		expect((row.input as { libs: string[] }).libs).toEqual([
			"pandas",
			"matplotlib",
			"sklearn",
		]);
		expect((row.input as { runtimeProbeCommand: string }).runtimeProbeCommand).toContain(
			'libs = ["pandas","matplotlib","sklearn"]',
		);
		expect(row.metadata).toMatchObject({
			bigcodebench: {
				libs: ["pandas", "matplotlib", "sklearn"],
			},
		});
	});

	it("maps BigCodeBench package names to importable module aliases", () => {
		const row = normalizeCodeEvalRowForEvaluation({
			suiteSlug: "bigcodebench",
			index: 0,
			row: {
				task_id: "BigCodeBench/alias",
				instruct_prompt: "Use package aliases.",
				entry_point: "task_func",
				libs: [
					"Pillow",
					"opencv-python-headless",
					"pycryptodome",
					"python-docx",
					"scikit-image",
					"PyYAML",
				],
				test: "def test_default():\n    assert task_func() is None\n",
			},
		});
		const command = (row.input as { runtimeProbeCommand: string }).runtimeProbeCommand;

		expect(command).toContain('"Pillow": "PIL"');
		expect(command).toContain('"opencv-python-headless": "cv2"');
		expect(command).toContain('"pycryptodome": "Crypto"');
		expect(command).toContain('"python-docx": "docx"');
		expect(command).toContain('"scikit-image": "skimage"');
		expect(command).toContain('"PyYAML": "yaml"');
		expect(command).toContain(
			'libs = ["Pillow","opencv-python-headless","pycryptodome","python-docx","scikit-image","PyYAML"]',
		);
	});

	it("unwraps Hugging Face dataset-server row envelopes", () => {
		const row = normalizeCodeEvalRowForEvaluation({
			suiteSlug: "humaneval-plus",
			index: 0,
			row: {
				row_idx: 7,
				row: {
					task_id: "HumanEval/7",
					prompt: "Write identity.",
					entry_point: "identity",
					test: "def check(candidate):\n    assert candidate(1) == 1\n",
				},
			},
		});

		expect(row.externalId).toBe("HumanEval/7");
		expect(row.metadata).toMatchObject({ sourceRowIndex: 7 });
	});

	it("uses only the deterministic Tests pass grader by default", () => {
		const graders = buildCodeEvalDefaultGraders();

		expect(graders).toEqual([
			{
				name: "Tests pass",
				type: "string_check",
				config: {
					operation: "equals",
					targetPath: "generatedOutput.workflowOutput.exitCode",
					value: "0",
				},
				passThreshold: 1,
				weight: 1,
				enabled: true,
			},
		]);
		expect(graders.map((grader) => grader.type)).not.toContain("score_model");
		expect(graders.every((grader) => grader.enabled !== false)).toBe(true);
	});

	it("validates runtime, restores canonical tests, captures solution, and runs pytest from a clean directory", () => {
		const workflow = JSON.parse(
			readFileSync("services/code-eval-runner/code-eval-item.workflow.json", "utf8"),
		) as {
			spec: {
				do: Array<
					Record<string, { call: string; if?: string; with: Record<string, unknown> }>
				>;
				output: Record<string, unknown>;
			};
			edges: Array<{ source: string; target: string }>;
		};
		const steps = workflow.spec.do.map((step) => Object.keys(step)[0]);
		expect(steps).toEqual([
			"workspace_profile",
			"validate_runtime",
			"write_test",
			"solve",
			"restore_test",
			"run_tests",
			"read_solution",
			"capture_metadata",
		]);
		expect(workflow.spec.do[0].workspace_profile.with.sandboxTemplate).toBe(
			'${ .trigger.sandboxTemplate // "code-eval-evalplus" }',
		);
		expect(workflow.spec.do[0].workspace_profile.with).not.toHaveProperty("sandboxImage");

		const validateRuntime = workflow.spec.do[1].validate_runtime;
		expect(validateRuntime.call).toBe("workspace/command");
		expect(validateRuntime.with.command).toBe("${ .trigger.runtimeProbeCommand }");
		expect(validateRuntime.with.allowFailure).toBe(true);

		const writeTest = workflow.spec.do[2].write_test;
		expect(writeTest.call).toBe("workspace/write_file");
		expect(writeTest.if).toBe("${ (.validate_runtime.exitCode // 1) == 0 }");
		expect(writeTest.with.timeoutMs).toBe(60_000);

		const solve = workflow.spec.do[3].solve;
		expect(solve.if).toBe("${ (.validate_runtime.exitCode // 1) == 0 }");
		expect(JSON.stringify(solve.with)).toContain("code-eval-evalplus");

		const restoreTest = workflow.spec.do[4].restore_test;
		expect(restoreTest.call).toBe("workspace/write_file");
		expect(restoreTest.if).toBe("${ (.validate_runtime.exitCode // 1) == 0 }");
		expect(restoreTest.with.path).toBe("/sandbox/test_solution.py");
		expect(restoreTest.with.content).toBe(
			"${ .trigger.evaluation.expectedOutput.testFileContent }",
		);
		expect(restoreTest.with.timeoutMs).toBe(60_000);

		const runTests = workflow.spec.do[5].run_tests;
		expect(runTests.call).toBe("workspace/command");
		expect(runTests.if).toBe("${ (.validate_runtime.exitCode // 1) == 0 }");
		expect(runTests.with.command).toContain("cp /sandbox/solution.py");
		expect(runTests.with.command).toContain("cp /sandbox/test_solution.py");
		expect(runTests.with.command).toContain(
			'CODE_EVAL_SOLUTION_PATH="${run_dir}/solution.py"',
		);
		expect(runTests.with.command).toContain("PYTEST_DISABLE_PLUGIN_AUTOLOAD=1");
		expect(runTests.with.command).toContain("/sandbox/.venv/bin/python -m pytest");
		expect(runTests.with.command).toContain("--noconftest test_solution.py");
		expect(runTests.with.allowFailure).toBe(true);

		const readSolution = workflow.spec.do[6].read_solution;
		expect(readSolution.call).toBe("workspace/read_file");
		expect(readSolution.if).toBe("${ (.validate_runtime.exitCode // 1) == 0 }");
		expect(readSolution.with.path).toBe("/sandbox/solution.py");

		const captureMetadata = workflow.spec.do[7].capture_metadata;
		expect(captureMetadata.call).toBe("workspace/command");
		expect(captureMetadata.if).toBe("${ (.validate_runtime.exitCode // 1) == 0 }");
		expect(captureMetadata.with.command).toContain("hashlib.sha256");
		expect(JSON.stringify(workflow.spec.output)).toContain("solutionContent");
		expect(JSON.stringify(workflow.spec.output)).toContain("solutionSha256");
		expect(JSON.stringify(workflow.spec.output)).toContain("runtimeProbe");
		expect(JSON.stringify(workflow.spec.output)).toContain(".run_tests.exitCode // 1");
		expect(workflow.edges).toEqual(
			expect.arrayContaining([
				{
					id: "e2",
					source: "workspace_profile",
					target: "validate_runtime",
					type: "default",
				},
				{
					id: "e6",
					source: "restore_test",
					target: "run_tests",
					type: "default",
				},
				{
					id: "e7",
					source: "run_tests",
					target: "read_solution",
					type: "default",
				},
			]),
		);
	});
});

describe("evaluation output extraction", () => {
	it("prefers generated output fields from workflow results", () => {
		expect(
			extractEvaluationGeneratedOutput({
				raw: "ignored",
				generatedOutput: { answer: "42" },
			}),
		).toEqual({ answer: "42" });
	});

	it("unwraps nested output/result objects", () => {
		expect(
			extractEvaluationGeneratedOutput({
				output: {
					result: {
						text: "final answer",
					},
				},
			}),
		).toBe("final answer");
	});

	it("extracts SWE-bench patches from generated output", () => {
		expect(
			extractSwebenchModelPatch({
				modelPatch: "diff --git a/a.py b/a.py\n+change",
			}),
		).toContain("diff --git");
	});

	it("collects trace IDs without confusing SHA-256 hashes for traces", () => {
		expect(
			collectEvaluationTraceIds(
				{ traceId: "0123456789abcdef0123456789abcdef" },
				{
					workflowOutput: {
						solutionSha256:
							"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
					outputs: [{ trace_ids: ["fedcba9876543210fedcba9876543210"] }],
				},
			),
		).toEqual([
			"0123456789abcdef0123456789abcdef",
			"fedcba9876543210fedcba9876543210",
		]);
	});

	it("classifies failed code-eval runtime probes as infrastructure failures", () => {
		expect(
			detectCodeEvalInfrastructureFailure(
				{ suite: "bigcodebench" },
				{
					workflowOutput: {
						exitCode: 0,
						runtimeProbe: {
							exitCode: 1,
							stderr: "ModuleNotFoundError: No module named 'pytest'",
						},
						protocol: {
							mode: "internal-agent-visible-tests",
							benchmarkComparable: false,
						},
					},
				},
			),
		).toContain("runtime validation failed");
	});
});

function codeEvalTestFileContent(row: ReturnType<typeof normalizeCodeEvalRowForEvaluation>) {
	expect(row.expectedOutput).toEqual(
		expect.objectContaining({ testFileContent: expect.any(String) }),
	);
	return (row.expectedOutput as { testFileContent: string }).testFileContent;
}

// ── Cutover P3: agent-eval script producer (item 15) ─────────────────────────
import {
	buildAgentEvaluationScript,
	extractEvaluationGeneratedOutput as extractGen,
} from "$lib/server/application/adapters/evaluation-service";

describe("buildAgentEvaluationScript (P3 producer port)", () => {
	const params = {
		evaluationName: "My Eval",
		agentId: "agent-123",
		agentVersion: 4 as number | null,
		input: { question: "2+2?" },
		taskConfig: { promptTemplate: "Answer: {{input.question}}" },
	};

	it("emits a named-agent script with the version pin and the {generatedOutput, raw} contract", () => {
		const { script, meta } = buildAgentEvaluationScript(params);
		expect(meta.name).toBe("evaluation-item");
		expect(script).toContain("export const meta =");
		expect(script).toContain("agent: \"agent-123\"");
		expect(script).toContain("agentVersion: 4");
		expect(script).toContain("return { generatedOutput, raw }");
		// The prompt template rendered against the item input.
		expect(script).toContain("2+2?");
	});

	it("omits agentVersion when the run pins no version", () => {
		const { script } = buildAgentEvaluationScript({ ...params, agentVersion: null });
		expect(script).not.toContain("agentVersion:");
	});
});

describe("extractEvaluationGeneratedOutput unwraps the dynamic-script envelope", () => {
	it("reads the script returnValue through {outputs: {returnValue}}", () => {
		const pumpOutput = {
			phase: "completed",
			success: true,
			outputs: { returnValue: { generatedOutput: "4", raw: "4" } },
		};
		expect(extractGen(pumpOutput)).toBe("4");
	});

	it("still reads the SW workflowOutput shape", () => {
		expect(extractGen({ generatedOutput: "sw-answer", raw: {} })).toBe("sw-answer");
	});
});

describe("buildSwebenchEvaluationScript (P3 producer port)", () => {
	it("emits the 4-step spine with the agent bound to the profile's sandbox", async () => {
		const { buildSwebenchEvaluationScript } = await import(
			"$lib/server/application/adapters/evaluation-service"
		);
		const { script, meta } = buildSwebenchEvaluationScript({
			evaluationName: "SWE-bench smoke",
			runId: "run-1",
			itemId: "item-1",
			agentId: "agent-9",
			agentVersion: null,
			input: {
				instanceId: "django__django-11099",
				repo: "django/django",
				baseCommit: "abc123",
				problemStatement: "fix the thing",
			},
			taskConfig: { adapter: "swebench", suiteSlug: "swe-bench-verified" },
			executionConfig: { timeoutSeconds: 600, maxTurns: 40 },
		});
		expect(meta.name).toBe("swebench-evaluation-item");
		// profile -> checkout -> solve(bound) -> extract
		expect(script).toContain("action('workspace/profile'");
		expect(script).toContain("label: 'checkout_repo'");
		expect(script).toContain("agent: \"agent-9\"");
		expect(script).toContain("workspaceRef: profile?.workspaceRef");
		expect(script).toContain("sandboxName: profile?.sandboxName");
		expect(script).toContain("label: 'extract_patch'");
		// The jq patch projection became JS with the same fallback chain.
		expect(script).toContain("extract?.result?.stdout ?? extract?.stdout");
		expect(script).toContain("modelPatch,");
	});
});

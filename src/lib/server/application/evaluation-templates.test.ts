import { describe, expect, it, vi } from "vitest";
import {
	ApplicationEvaluationTemplateService,
	type EvaluationDatasetImportParser,
	type EvaluationTemplateRepository,
} from "$lib/server/application/evaluation-templates";

describe("ApplicationEvaluationTemplateService", () => {
	it("lists SWE-bench suites through the catalog port", () => {
		const service = createService();
		expect(service.listSwebenchSuites()).toEqual({
			suites: [{ slug: "SWE-bench_Lite" }],
		});
	});

	it("parses imported rows before creating SWE-bench templates", async () => {
		const templates = createTemplateRepository();
		const imports = {
			parse: vi.fn(() => [{ instance_id: "astropy__astropy-1" }]),
		};
		const service = createService({ templates, imports });

		await service.createSwebench({
			projectId: "project-1",
			userId: "user-1",
			body: {
				suiteSlug: "SWE-bench_Lite",
				content: '{"instance_id":"astropy__astropy-1"}',
				format: "jsonl",
				instanceIds: ["unused"],
			},
		});

		expect(imports.parse).toHaveBeenCalledWith(
			'{"instance_id":"astropy__astropy-1"}',
			"jsonl",
		);
		expect(templates.createSwebench).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			suiteSlug: "SWE-bench_Lite",
			name: null,
			description: null,
			instanceIds: ["unused"],
			rows: [{ instance_id: "astropy__astropy-1" }],
		});
	});

	it("creates code-eval templates with the selected suite", async () => {
		const templates = createTemplateRepository();
		const service = createService({ templates });

		await service.createCodeEval({
			projectId: "project-1",
			userId: "user-1",
			suiteSlug: "humaneval-plus",
			body: {
				name: "HumanEval smoke",
				graderAgentSlug: "evaluator-default",
				rows: [{ task_id: "HumanEval/0" }],
			},
		});

		expect(templates.createCodeEval).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			suiteSlug: "humaneval-plus",
			name: "HumanEval smoke",
			description: null,
			graderAgentSlug: "evaluator-default",
			rows: [{ task_id: "HumanEval/0" }],
		});
	});
});

function createService(overrides: {
	templates?: EvaluationTemplateRepository;
	imports?: EvaluationDatasetImportParser;
} = {}) {
	return new ApplicationEvaluationTemplateService({
		templates: overrides.templates ?? createTemplateRepository(),
		imports: overrides.imports ?? {
			parse: vi.fn((_content: string, _format: "jsonl" | "json" | "csv") => []),
		},
		swebenchSuites: { listSuites: () => [{ slug: "SWE-bench_Lite" }] },
	});
}

function createTemplateRepository(): EvaluationTemplateRepository {
	return {
		createSwebench: vi.fn(async () => ({ dataset: {}, evaluation: {} })),
		createCodeEval: vi.fn(async () => ({ dataset: {}, evaluation: {} })),
	};
}

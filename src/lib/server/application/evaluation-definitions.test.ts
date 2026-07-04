import { describe, expect, it, vi } from "vitest";
import {
	ApplicationEvaluationDefinitionService,
	type EvaluationDefinitionRepository,
} from "$lib/server/application/evaluation-definitions";

describe("ApplicationEvaluationDefinitionService", () => {
	it("returns an empty list without a project and delegates reads", async () => {
		const repository = createRepository({
			list: vi.fn(async () => [{ id: "eval-1" }]),
			get: vi.fn(async () => ({ id: "eval-1" })),
		});
		const service = new ApplicationEvaluationDefinitionService(repository);

		await expect(service.list({ projectId: null })).resolves.toEqual({
			evaluations: [],
		});
		await expect(service.list({ projectId: "project-1" })).resolves.toEqual({
			evaluations: [{ id: "eval-1" }],
		});
		await expect(
			service.get({ projectId: "project-1", evaluationId: "eval-1" }),
		).resolves.toEqual({ evaluation: { id: "eval-1" } });

		expect(repository.list).toHaveBeenCalledWith("project-1");
		expect(repository.get).toHaveBeenCalledWith("project-1", "eval-1");
	});

	it("normalizes create and update commands before calling repository ports", async () => {
		const repository = createRepository({
			create: vi.fn(async () => ({ id: "eval-2" })),
			update: vi.fn(async () => ({ id: "eval-2", name: "Updated" })),
		});
		const service = new ApplicationEvaluationDefinitionService(repository);
		const body = {
			name: "Quality Gate",
			description: 123,
			datasetId: "dataset-1",
			taskConfig: { workflowId: "wf-1" },
			dataSourceConfig: { source: "dataset" },
			testingCriteria: { pass: true },
			metadata: { owner: "evals" },
			graders: [{ name: "Correctness" }],
		};

		await service.create({
			projectId: "project-1",
			userId: "user-1",
			body,
		});
		await service.update({
			projectId: "project-1",
			evaluationId: "eval-2",
			body: { name: "Updated" },
		});

		expect(repository.create).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			name: "Quality Gate",
			description: null,
			datasetId: "dataset-1",
			taskConfig: { workflowId: "wf-1" },
			dataSourceConfig: { source: "dataset" },
			testingCriteria: { pass: true },
			metadata: { owner: "evals" },
			graders: [{ name: "Correctness" }],
		});
		expect(repository.update).toHaveBeenCalledWith({
			projectId: "project-1",
			evaluationId: "eval-2",
			patch: { name: "Updated" },
		});
	});

	it("maps repository errors to application errors", async () => {
		const service = new ApplicationEvaluationDefinitionService(
			createRepository({
				create: vi.fn(async () => {
					const err = new Error("Evaluation name is required") as Error & {
						status: number;
					};
					err.status = 400;
					throw err;
				}),
			}),
		);

		await expect(
			service.create({
				projectId: "project-1",
				userId: "user-1",
				body: {},
			}),
		).rejects.toMatchObject({
			status: 400,
			message: "Evaluation name is required",
		});
	});
});

function createRepository(
	overrides: Partial<EvaluationDefinitionRepository> = {},
): EvaluationDefinitionRepository {
	return {
		list: vi.fn(async () => []),
		get: vi.fn(async () => null),
		create: vi.fn(async () => ({ id: "eval-1" })),
		update: vi.fn(async () => ({ id: "eval-1" })),
		...overrides,
	};
}

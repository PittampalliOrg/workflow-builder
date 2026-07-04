import { describe, expect, it, vi } from "vitest";
import {
	ApplicationEvaluationDatasetService,
	type EvaluationDatasetRepository,
} from "$lib/server/application/evaluation-datasets";

describe("ApplicationEvaluationDatasetService", () => {
	it("returns an empty list without a project and delegates project reads", async () => {
		const repository = createRepository({
			list: vi.fn(async () => [{ id: "dataset-1" }]),
			get: vi.fn(async () => ({ id: "dataset-1", rows: [{ id: "row-1" }] })),
		});
		const service = new ApplicationEvaluationDatasetService(repository);

		await expect(service.list({ projectId: null })).resolves.toEqual({
			datasets: [],
		});
		await expect(service.list({ projectId: "project-1" })).resolves.toEqual({
			datasets: [{ id: "dataset-1" }],
		});
		await expect(
			service.get({
				projectId: "project-1",
				datasetId: "dataset-1",
				limitParam: "25",
			}),
		).resolves.toEqual({ dataset: { id: "dataset-1", rows: [{ id: "row-1" }] } });

		expect(repository.list).toHaveBeenCalledWith("project-1");
		expect(repository.get).toHaveBeenCalledWith(
			"project-1",
			"dataset-1",
			25,
		);
	});

	it("normalizes create and row commands before calling repository ports", async () => {
		const repository = createRepository({
			create: vi.fn(async () => ({ id: "dataset-2" })),
			createRows: vi.fn(async () => [{ id: "row-1" }]),
			updateRow: vi.fn(async () => ({ id: "row-1", rating: 1 })),
		});
		const service = new ApplicationEvaluationDatasetService(repository);
		const body = {
			name: "Regression rows",
			description: 123,
			sourceType: "manual",
			sourceUrl: "https://example.test/data.jsonl",
			schema: { input: "object" },
			metadata: { owner: "evals" },
			rows: [{ input: { prompt: "hi" } }],
		};

		await service.create({
			projectId: "project-1",
			userId: "user-1",
			body,
		});
		await service.createRows({
			projectId: "project-1",
			datasetId: "dataset-1",
			body: { input: { prompt: "one" } },
		});
		await service.updateRow({
			projectId: "project-1",
			datasetId: "dataset-1",
			rowId: "row-1",
			body: { rating: 1 },
		});

		expect(repository.create).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			name: "Regression rows",
			description: null,
			sourceType: "manual",
			sourceUrl: "https://example.test/data.jsonl",
			schema: { input: "object" },
			metadata: { owner: "evals" },
			rows: [{ input: { prompt: "hi" } }],
		});
		expect(repository.createRows).toHaveBeenCalledWith(
			"project-1",
			"dataset-1",
			[{ input: { prompt: "one" } }],
		);
		expect(repository.updateRow).toHaveBeenCalledWith({
			projectId: "project-1",
			datasetId: "dataset-1",
			rowId: "row-1",
			patch: { rating: 1 },
		});
	});

	it("parses imported content and persists rows through repository ports", async () => {
		const repository = createRepository({
			createRows: vi.fn(async () => [{ id: "row-1" }, { id: "row-2" }]),
		});
		const imports = {
			parse: vi.fn(() => [
				{ input: { prompt: "one" } },
				{ input: { prompt: "two" } },
			]),
		};
		const service = new ApplicationEvaluationDatasetService(
			repository,
			imports,
		);

		await expect(
			service.importRows({
				projectId: "project-1",
				datasetId: "dataset-1",
				format: "jsonl",
				content: "{\"input\":{\"prompt\":\"one\"}}\n",
			}),
		).resolves.toEqual({
			rows: [{ id: "row-1" }, { id: "row-2" }],
			imported: 2,
		});

		expect(imports.parse).toHaveBeenCalledWith(
			"{\"input\":{\"prompt\":\"one\"}}\n",
			"jsonl",
		);
		expect(repository.createRows).toHaveBeenCalledWith(
			"project-1",
			"dataset-1",
			[{ input: { prompt: "one" } }, { input: { prompt: "two" } }],
		);
	});

	it("maps repository errors to application errors", async () => {
		const service = new ApplicationEvaluationDatasetService(
			createRepository({
				deleteRow: vi.fn(async () => {
					const err = new Error("Dataset row not found") as Error & {
						status: number;
					};
					err.status = 404;
					throw err;
				}),
			}),
		);

		await expect(
			service.deleteRow({
				projectId: "project-1",
				datasetId: "dataset-1",
				rowId: "missing",
			}),
		).rejects.toMatchObject({
			status: 404,
			message: "Dataset row not found",
		});
	});
});

function createRepository(
	overrides: Partial<EvaluationDatasetRepository> = {},
): EvaluationDatasetRepository {
	return {
		list: vi.fn(async () => []),
		get: vi.fn(async () => ({ id: "dataset-1", rows: [] })),
		create: vi.fn(async () => ({ id: "dataset-1" })),
		update: vi.fn(async () => ({ id: "dataset-1" })),
		createRows: vi.fn(async () => []),
		updateRow: vi.fn(async () => ({ id: "row-1" })),
		deleteRow: vi.fn(async () => ({ success: true })),
		...overrides,
	};
}

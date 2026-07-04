import { describe, expect, it, vi } from "vitest";
import {
	ApplicationEvaluationRunItemService,
	type EvaluationRunItemRepository,
} from "$lib/server/application/evaluation-run-items";

describe("ApplicationEvaluationRunItemService", () => {
	it("loads scoped run items through the repository", async () => {
		const repository = createRepository({
			getItem: vi.fn(async () => ({ id: "item-1" })),
		});
		const service = new ApplicationEvaluationRunItemService(repository);

		await expect(
			service.get({
				projectId: "project-1",
				runId: "run-1",
				itemId: "item-1",
			}),
		).resolves.toEqual({ item: { id: "item-1" } });

		expect(repository.getItem).toHaveBeenCalledWith(
			"project-1",
			"run-1",
			"item-1",
		);
	});

	it("normalizes public output updates and returns the refreshed run", async () => {
		const repository = createRepository({
			getRun: vi
				.fn()
				.mockResolvedValueOnce({ id: "run-1", status: "running" })
				.mockResolvedValueOnce({ id: "run-1", status: "completed" }),
			updateOutput: vi.fn(async () => ({ id: "item-1" })),
		});
		const service = new ApplicationEvaluationRunItemService(repository);

		await expect(
			service.updatePublicOutput({
				projectId: "project-1",
				runId: "run-1",
				itemId: "item-1",
				body: {
					output: { answer: 42 },
					usage: { tokens: 10 },
					traceIds: [123, "abc"],
					autoGrade: false,
				},
			}),
		).resolves.toEqual({
			item: { id: "item-1" },
			run: { id: "run-1", status: "completed" },
		});

		expect(repository.updateOutput).toHaveBeenCalledWith({
			runId: "run-1",
			itemId: "item-1",
			generatedOutput: { answer: 42 },
			usage: { tokens: 10 },
			traceIds: ["123", "abc"],
			autoGrade: false,
		});
	});

	it("maps missing rows to application errors", async () => {
		const service = new ApplicationEvaluationRunItemService(
			createRepository({
				getItem: vi.fn(async () => null),
			}),
		);

		await expect(
			service.get({
				projectId: "project-1",
				runId: "run-1",
				itemId: "missing",
			}),
		).rejects.toMatchObject({
			status: 404,
			message: "Evaluation run item not found",
		});
	});
});

function createRepository(
	overrides: Partial<EvaluationRunItemRepository> = {},
): EvaluationRunItemRepository {
	return {
		getRun: vi.fn(async () => ({ id: "run-1" })),
		getItem: vi.fn(async () => ({ id: "item-1" })),
		updateOutput: vi.fn(async () => ({ id: "item-1" })),
		...overrides,
	};
}

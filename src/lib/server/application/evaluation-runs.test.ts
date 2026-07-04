import { describe, expect, it, vi } from "vitest";
import {
	ApplicationEvaluationRunService,
	type EvaluationRunRepository,
} from "$lib/server/application/evaluation-runs";

describe("ApplicationEvaluationRunService", () => {
	it("loads internal status and validates status transitions", async () => {
		const repository = createRepository({
			getInternalRun: vi.fn(async () => ({ id: "run-1" })),
			markStatus: vi.fn(async () => ({ id: "run-1", status: "running" })),
			recomputeSummary: vi.fn(async () => ({ ok: true })),
		});
		const service = new ApplicationEvaluationRunService(repository);

		await expect(service.getInternalStatus({ runId: "run-1" })).resolves.toEqual({
			run: { id: "run-1" },
		});
		await expect(
			service.markStatus({
				runId: "run-1",
				body: {
					status: "running",
					error: null,
					coordinatorExecutionId: "coord-1",
					summary: { passed: 1 },
					usage: { tokens: 10 },
				},
			}),
		).resolves.toEqual({
			success: true,
			run: { id: "run-1", status: "running" },
		});

		expect(repository.getInternalRun).toHaveBeenCalledWith("run-1", {
			itemMode: "summary",
		});
		expect(repository.markStatus).toHaveBeenCalledWith("run-1", "running", {
			error: null,
			coordinatorExecutionId: "coord-1",
			summary: { passed: 1 },
			usage: { tokens: 10 },
		});
		expect(repository.recomputeSummary).toHaveBeenCalledWith("run-1");
	});

	it("normalizes artifact recording", async () => {
		const repository = createRepository({
			recordArtifact: vi.fn(async () => ({ id: "artifact-1" })),
		});
		const service = new ApplicationEvaluationRunService(repository);

		await expect(
			service.recordArtifact({
				runId: "run-1",
				body: {
					runItemId: "item-1",
					kind: "predictions_jsonl",
					path: "runs/run-1/predictions.jsonl",
					content: "jsonl",
					contentType: "application/jsonl",
					metadata: { count: 1 },
				},
			}),
		).resolves.toEqual({
			success: true,
			artifact: { id: "artifact-1" },
		});

		expect(repository.recordArtifact).toHaveBeenCalledWith({
			runId: "run-1",
			runItemId: "item-1",
			kind: "predictions_jsonl",
			path: "runs/run-1/predictions.jsonl",
			content: "jsonl",
			contentType: "application/jsonl",
			metadata: { count: 1 },
		});
	});

	it("delegates grade and predictions commands", async () => {
		const repository = createRepository({
			gradeRun: vi.fn(async () => ({ id: "run-1", status: "grading" })),
			buildPredictionsJsonl: vi.fn(async () => "{\"id\":\"one\"}\n"),
		});
		const service = new ApplicationEvaluationRunService(repository);

		await expect(
			service.gradeRun({ projectId: "project-1", runId: "run-1" }),
		).resolves.toEqual({ run: { id: "run-1", status: "grading" } });
		await expect(
			service.buildPredictionsJsonl({
				projectId: "project-1",
				runId: "run-1",
			}),
		).resolves.toBe("{\"id\":\"one\"}\n");

		expect(repository.gradeRun).toHaveBeenCalledWith("project-1", "run-1");
		expect(repository.buildPredictionsJsonl).toHaveBeenCalledWith(
			"project-1",
			"run-1",
		);
	});

	it("maps invalid status and artifact kind to application errors", async () => {
		const service = new ApplicationEvaluationRunService(createRepository());

		await expect(
			service.markStatus({ runId: "run-1", body: { status: "wat" } }),
		).rejects.toMatchObject({
			status: 400,
			message: "Invalid evaluation run status",
		});
		await expect(
			service.recordArtifact({ runId: "run-1", body: { kind: "wat" } }),
		).rejects.toMatchObject({
			status: 400,
			message: "Invalid artifact kind",
		});
	});
});

function createRepository(
	overrides: Partial<EvaluationRunRepository> = {},
): EvaluationRunRepository {
	return {
		getInternalRun: vi.fn(async () => ({ id: "run-1" })),
		markStatus: vi.fn(async () => ({ id: "run-1" })),
		recomputeSummary: vi.fn(async () => ({ ok: true })),
		recordArtifact: vi.fn(async () => ({ id: "artifact-1" })),
		gradeRun: vi.fn(async () => ({ id: "run-1" })),
		buildPredictionsJsonl: vi.fn(async () => ""),
		...overrides,
	};
}

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApplicationEvaluationRunDetailService,
	type EvaluationRunDetailReadPort,
} from "$lib/server/application/evaluation-run-detail";

describe("ApplicationEvaluationRunDetailService", () => {
	let readModel: EvaluationRunDetailReadPort;
	let service: ApplicationEvaluationRunDetailService;

	beforeEach(() => {
		readModel = {
			getRun: vi.fn(async () => ({ id: "run-1", items: [] }) as never),
		};
		service = new ApplicationEvaluationRunDetailService(readModel);
	});

	it("returns not found without a project scope", async () => {
		await expect(
			service.getRun({
				projectId: null,
				runId: "run-1",
				itemMode: "summary",
			}),
		).resolves.toEqual({
			status: "not_found",
			message: "Evaluation run not found",
		});
		expect(readModel.getRun).not.toHaveBeenCalled();
	});

	it("fetches the run through the read port with the requested item mode", async () => {
		await expect(
			service.getRun({
				projectId: "project-1",
				runId: "run-1",
				itemMode: "summary",
			}),
		).resolves.toEqual({
			status: "ok",
			body: { run: { id: "run-1", items: [] } },
		});

		expect(readModel.getRun).toHaveBeenCalledWith("project-1", "run-1", {
			itemMode: "summary",
		});
	});

	it("maps missing rows to a route-friendly not found result", async () => {
		vi.mocked(readModel.getRun).mockResolvedValueOnce(null);

		await expect(
			service.getRun({
				projectId: "project-1",
				runId: "missing",
				itemMode: "full",
			}),
		).resolves.toEqual({
			status: "not_found",
			message: "Evaluation run not found",
		});
	});
});

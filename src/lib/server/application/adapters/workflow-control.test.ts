import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
	confirmDurableStop: vi.fn(),
	stopDurableRun: vi.fn(),
}));

vi.mock("$lib/server/lifecycle", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/lifecycle")>();
	return {
		...actual,
		confirmDurableStop: lifecycle.confirmDurableStop,
		stopDurableRun: lifecycle.stopDurableRun,
	};
});

import { LifecycleWorkflowExecutionControllerPort } from "./workflow-control";

describe("LifecycleWorkflowExecutionControllerPort runtime-host cleanup hint", () => {
	const requestReap = vi.fn();
	const controller = new LifecycleWorkflowExecutionControllerPort({
		requestReap,
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("signals cleanup after a confirmed terminal stop", async () => {
		lifecycle.stopDurableRun.mockResolvedValue({
			confirmed: true,
			state: "confirmed",
		});

		await controller.stopExecution("execution-1", {
			mode: "terminate",
			reason: "done",
		});

		expect(requestReap).toHaveBeenCalledOnce();
	});

	it("does not signal cleanup for interrupt or an unconfirmed stop", async () => {
		lifecycle.stopDurableRun
			.mockResolvedValueOnce({ confirmed: true, state: "confirmed" })
			.mockResolvedValueOnce({ confirmed: false, state: "stopping" });

		await controller.stopExecution("execution-1", { mode: "interrupt" });
		await controller.stopExecution("execution-1", { mode: "purge" });

		expect(requestReap).not.toHaveBeenCalled();
	});

	it("signals cleanup only after confirmation reaches confirmed", async () => {
		lifecycle.confirmDurableStop
			.mockResolvedValueOnce({ state: "stopping", scope: null })
			.mockResolvedValueOnce({ state: "confirmed", scope: null });

		await controller.confirmExecutionStop("execution-1");
		expect(requestReap).not.toHaveBeenCalled();
		await controller.confirmExecutionStop("execution-1");
		expect(requestReap).toHaveBeenCalledOnce();
	});
});

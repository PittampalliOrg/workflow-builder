import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowRunStarterPort } from "$lib/server/application/ports";
import {
	ApplicationTriggeredWorkflowStartService,
	type TriggeredRunAdmissionPort,
	type TriggeredWorkflowExecutionIdPort,
	type TriggeredWorkflowStartLogger,
} from "$lib/server/application/triggered-workflow-start";

describe("ApplicationTriggeredWorkflowStartService", () => {
	let admission: TriggeredRunAdmissionPort;
	let executionIds: TriggeredWorkflowExecutionIdPort;
	let runStarter: WorkflowRunStarterPort;
	let logger: TriggeredWorkflowStartLogger;
	let service: ApplicationTriggeredWorkflowStartService;

	beforeEach(() => {
		admission = {
			admitTriggeredRun: vi.fn(async () => ({
				admit: true,
				active: 0,
				cap: 10,
			})),
		};
		executionIds = {
			executionIdForDedupKey: vi.fn(() => "evt-abc123"),
		};
		runStarter = {
			startWorkflowRun: vi.fn(async () => ({
				ok: true as const,
				executionId: "evt-abc123",
				instanceId: "sw-example-exec-evt-abc123",
				workflowId: "workflow-1",
				workflowName: "Example",
				reused: false,
			})),
		};
		logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
		service = new ApplicationTriggeredWorkflowStartService({
			admission,
			executionIds,
			runStarter,
			logger,
		});
	});

	it("normalizes CloudEvents and starts idempotent workflow runs through ports", async () => {
		const result = await service.handleTriggerMessage({
			id: "ce-1",
			data: {
				workflowId: " workflow-1 ",
				dedupKey: "dedup-1",
				triggerId: " trigger-row-1 ",
				triggerData: { prompt: "ship it" },
			},
		});

		expect(result).toEqual({ daprStatus: "SUCCESS" });
		expect(admission.admitTriggeredRun).toHaveBeenCalledOnce();
		expect(executionIds.executionIdForDedupKey).toHaveBeenCalledWith("dedup-1");
		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith({
			workflowId: "workflow-1",
			workflowName: undefined,
			triggerData: { prompt: "ship it", eventId: "ce-1" },
			executionId: "evt-abc123",
			idempotent: true,
			triggerSource: "trigger-row-1",
		});
	});

	it("uses the CloudEvent id as the dedup fallback and starts by workflow name", async () => {
		await service.handleTriggerMessage({
			id: "ce-2",
			data: {
				workflowName: " nightly-import ",
				triggerData: { eventId: "explicit" },
			},
		});

		expect(executionIds.executionIdForDedupKey).toHaveBeenCalledWith("ce-2");
		expect(runStarter.startWorkflowRun).toHaveBeenCalledWith(
			expect.objectContaining({
				workflowId: undefined,
				workflowName: "nightly-import",
				triggerData: { eventId: "explicit" },
				triggerSource: "event:nightly-import",
			}),
		);
	});

	it("drops malformed or incomplete messages without touching admission or start ports", async () => {
		await expect(service.handleTriggerMessage("not-an-object")).resolves.toEqual({
			daprStatus: "SUCCESS",
		});
		await expect(
			service.handleTriggerMessage({ id: "ce-1", data: { dedupKey: "d1" } }),
		).resolves.toEqual({ daprStatus: "SUCCESS" });

		expect(admission.admitTriggeredRun).not.toHaveBeenCalled();
		expect(runStarter.startWorkflowRun).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			"[workflow-triggers/start] missing dedupKey or workflow ref; dropping",
			expect.objectContaining({ hasDedup: true }),
		);
	});

	it("returns RETRY when the trigger admission gate defers the run", async () => {
		vi.mocked(admission.admitTriggeredRun).mockResolvedValueOnce({
			admit: false,
			active: 10,
			cap: 10,
		});

		await expect(
			service.handleTriggerMessage({
				id: "ce-1",
				data: { workflowId: "workflow-1", dedupKey: "dedup-1" },
			}),
		).resolves.toEqual({ daprStatus: "RETRY" });

		expect(runStarter.startWorkflowRun).not.toHaveBeenCalled();
	});

	it("ACKs start failures and unexpected errors so poison messages do not wedge pub/sub", async () => {
		vi.mocked(runStarter.startWorkflowRun)
			.mockResolvedValueOnce({
				ok: false as const,
				status: 404,
				error: "Workflow not found",
			})
			.mockRejectedValueOnce(new Error("boom"));

		await expect(
			service.handleTriggerMessage({
				id: "ce-1",
				data: { workflowId: "workflow-1", dedupKey: "dedup-1" },
			}),
		).resolves.toEqual({ daprStatus: "SUCCESS" });
		await expect(
			service.handleTriggerMessage({
				id: "ce-2",
				data: { workflowId: "workflow-1", dedupKey: "dedup-2" },
			}),
		).resolves.toEqual({ daprStatus: "SUCCESS" });

		expect(logger.warn).toHaveBeenCalledWith(
			"[workflow-triggers/start] start failed; dropping message",
			expect.objectContaining({ status: 404, error: "Workflow not found" }),
		);
		expect(logger.error).toHaveBeenCalledWith(
			"[workflow-triggers/start] unexpected error; ACK to avoid wedge",
			expect.any(Error),
		);
	});
});

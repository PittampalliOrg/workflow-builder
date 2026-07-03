import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationWorkflowExecutionStreamService } from "$lib/server/application/workflow-execution-stream";
import type {
	WorkflowDataService,
	WorkflowExecutionReadModelPort,
} from "$lib/server/application/ports";
import type { ExecutionReadModel } from "$lib/types/execution-stream";

describe("ApplicationWorkflowExecutionStreamService", () => {
	let workflowData: Pick<
		WorkflowDataService,
		| "listExecutionSessionIds"
		| "listExecutionAgentEventsAfter"
		| "listenSessionEventNotifications"
	>;
	let executionReadModels: WorkflowExecutionReadModelPort;
	let service: ApplicationWorkflowExecutionStreamService;

	beforeEach(() => {
		workflowData = {
			listExecutionSessionIds: vi.fn(async () => ["session-1"]),
			listExecutionAgentEventsAfter: vi.fn(async () => []),
			listenSessionEventNotifications: vi.fn(async () => ({
				unlisten: vi.fn(async () => undefined),
			})),
		};
		executionReadModels = {
			loadExecutionReadModel: vi.fn(async () => executionModel()),
			serializeExecutionReadModel: vi.fn((model) => ({
				executionId: (model as ExecutionReadModel).executionId,
				status: (model as ExecutionReadModel).status,
			})),
		};
		service = new ApplicationWorkflowExecutionStreamService({
			workflowData,
			executionReadModels,
		});
	});

	it("emits a snapshot and terminal event for an already terminal execution", async () => {
		const stream = service.createEventStream({ executionId: "exec-1" });
		const output = await readStream(stream);

		expect(executionReadModels.loadExecutionReadModel).toHaveBeenCalledWith({
			executionId: "exec-1",
			refreshRuntime: true,
			includeAgentEvents: true,
		});
		expect(executionReadModels.serializeExecutionReadModel).toHaveBeenCalledWith(
			expect.objectContaining({ executionId: "exec-1", status: "success" }),
			{ compact: false, includeAgentEvents: true },
		);
		expect(workflowData.listenSessionEventNotifications).not.toHaveBeenCalled();
		expect(output).toContain("event: snapshot");
		expect(output).toContain('"executionId":"exec-1"');
		expect(output).toContain("event: terminal");
		expect(output).toContain('"status":"success"');
	});

	it("emits an error event when the execution read model is missing", async () => {
		vi.mocked(executionReadModels.loadExecutionReadModel).mockResolvedValueOnce(
			null,
		);

		const output = await readStream(
			service.createEventStream({ executionId: "missing-exec" }),
		);

		expect(output).toContain("event: error");
		expect(output).toContain("Execution not found");
		expect(workflowData.listExecutionSessionIds).not.toHaveBeenCalled();
	});
});

function executionModel(): ExecutionReadModel {
	return {
		executionId: "exec-1",
		workflowId: "workflow-1",
		instanceId: "instance-1",
		status: "success",
		runtimeStatus: "COMPLETED",
		phase: "complete",
		progress: 1,
		currentNodeId: null,
		currentNodeName: null,
		traceId: null,
		traceIds: [],
		sessionId: null,
		input: null,
		output: null,
		summaryOutput: null,
		error: null,
		startedAt: "2026-01-01T00:00:00.000Z",
		completedAt: "2026-01-01T00:00:01.000Z",
		steps: [],
		nodeStatuses: {},
		browserArtifacts: [],
		lastAgentEventId: 0,
		agentRuns: [],
		agentEvents: [],
		artifacts: [],
		workspaces: [],
	};
}

async function readStream(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let output = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		output += decoder.decode(value, { stream: true });
	}
	output += decoder.decode();
	return output;
}

import type {
	WorkflowExecutionRecord,
	WorkflowApprovalEventPort,
	WorkflowDataService,
} from "$lib/server/application/ports";

export type WorkflowExecutionControlInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
	body?: Record<string, unknown>;
};

export type WorkflowExecutionControlResult =
	| {
			status: "ok";
			body: Record<string, unknown>;
	  }
	| {
			status: "error";
			httpStatus: number;
			message: string;
	  };

export class ApplicationWorkflowExecutionControlService {
	constructor(
		private readonly deps: {
			workflowData: Pick<WorkflowDataService, "getExecutionById">;
			approvalEvents: WorkflowApprovalEventPort;
		},
	) {}

	async approveExecution(
		input: WorkflowExecutionControlInput,
	): Promise<WorkflowExecutionControlResult> {
		const eventType = approvalEventType(input.body);
		const execution = await this.deps.workflowData.getExecutionById(
			input.executionId,
		);
		if (!isExecutionInScope(execution, input)) {
			return workflowControlError(404, "Execution not found");
		}

		if (!execution.daprInstanceId) {
			return workflowControlError(409, "Run has no Dapr instance to signal");
		}

		const raised = await this.deps.approvalEvents.raiseApprovalEvent({
			instanceId: execution.daprInstanceId,
			eventType,
			approvedBy: input.userId,
		});
		if (!raised.ok) {
			console.error(
				`[approve] orchestrator ${raised.status}:`,
				raised.detail.slice(0, 300),
			);
			return workflowControlError(
				raised.status === 404 ? 409 : 502,
				"Failed to raise approval event",
			);
		}

		return {
			status: "ok",
			body: { ok: true, eventType, instanceId: execution.daprInstanceId },
		};
	}
}

function approvalEventType(body: Record<string, unknown> | undefined): string {
	const value = body?.eventType;
	return typeof value === "string" && value.trim()
		? value.trim()
		: "goal_spec_approval";
}

function isExecutionInScope(
	execution: WorkflowExecutionRecord | null,
	input: { userId: string; projectId?: string | null },
): execution is WorkflowExecutionRecord {
	if (!execution) return false;
	if (execution.projectId && input.projectId) {
		return execution.projectId === input.projectId;
	}
	if (!execution.projectId) {
		return execution.userId === input.userId;
	}
	return execution.userId === input.userId;
}

function workflowControlError(
	httpStatus: number,
	message: string,
): WorkflowExecutionControlResult {
	return { status: "error", httpStatus, message };
}

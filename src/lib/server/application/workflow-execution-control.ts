import type {
	WorkflowExecutionRecord,
	WorkflowApprovalEventPort,
	WorkflowDataService,
	WorkflowExecutionCoordinatorOwnerPort,
	WorkflowRunStarterPort,
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
			httpStatus?: number;
	  }
	| {
			status: "error";
			httpStatus: number;
			message: string;
	  };

export class ApplicationWorkflowExecutionControlService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				"getExecutionById" | "getWorkflowByRef"
			>;
			approvalEvents: WorkflowApprovalEventPort;
			coordinatorOwners: WorkflowExecutionCoordinatorOwnerPort;
			runStarter: WorkflowRunStarterPort;
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

	async resumeExecution(
		input: WorkflowExecutionControlInput,
	): Promise<WorkflowExecutionControlResult> {
		let fromNodeId = resumeNodeId(input.body);
		const source = await this.deps.workflowData.getExecutionById(
			input.executionId,
		);
		if (!isExecutionInScope(source, input)) {
			return workflowControlError(404, "Execution not found");
		}
		if (!source.daprInstanceId) {
			return workflowControlError(
				409,
				"Run has no Dapr instance id to resume from",
			);
		}

		const owner = await this.deps.coordinatorOwners.getCoordinatorOwner(
			input.executionId,
		);
		if (owner) {
			return {
				status: "ok",
				httpStatus: 409,
				body: {
					ok: false,
					error: "coordinator_owned",
					ownedBy: owner.kind,
					runId: owner.runId,
					message:
						"This is a benchmark/eval instance — resume via the owning run instead.",
				},
			};
		}

		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: source.workflowId,
			lookup: "id",
		});
		if (!workflow) return workflowControlError(404, "Workflow not found");
		const nodeIds = topLevelNodeIds(workflow.spec);

		if (!fromNodeId) fromNodeId = source.currentNodeId ?? undefined;
		if (!fromNodeId) {
			return workflowControlError(
				400,
				"Could not determine a resume node; pass fromNodeId",
			);
		}
		if (nodeIds.length && !nodeIds.includes(fromNodeId)) {
			return workflowControlError(
				404,
				`Node '${fromNodeId}' is not a top-level node in the current workflow`,
			);
		}

		const seedWorkspaceFrom = await this.resolveWorkspaceExecutionId(source);
		const result = await this.deps.runStarter.startWorkflowRun({
			workflowId: source.workflowId,
			triggerData: (source.input ?? {}) as Record<string, unknown>,
			resumeFromNode: fromNodeId,
			seedWorkspaceFrom: seedWorkspaceFrom ?? undefined,
			rerunOfExecutionId: source.id,
			rerunSourceInstanceId: source.daprInstanceId,
			triggerSource: "resume",
		});
		if (!result.ok) {
			return workflowControlError(result.status, result.error);
		}

		return {
			status: "ok",
			body: {
				ok: true,
				executionId: result.executionId,
				sourceExecutionId: source.id,
				newInstanceId: result.instanceId,
				fromNodeId,
				seedWorkspaceFrom,
			},
		};
	}

	private async resolveWorkspaceExecutionId(
		source: WorkflowExecutionRecord,
	): Promise<string | null> {
		let current = source;
		for (let hops = 0; hops < 20 && current.rerunOfExecutionId; hops++) {
			const parent = await this.deps.workflowData.getExecutionById(
				current.rerunOfExecutionId,
			);
			if (!parent) break;
			current = parent;
		}
		return current.daprInstanceId;
	}
}

function resumeNodeId(body: Record<string, unknown> | undefined): string | undefined {
	const raw =
		typeof body?.fromNodeId === "string" && body.fromNodeId.trim()
			? body.fromNodeId.trim()
			: undefined;
	if (!raw?.includes("/")) return raw;
	return raw.split("/").filter(Boolean).pop() ?? raw;
}

function approvalEventType(body: Record<string, unknown> | undefined): string {
	const value = body?.eventType;
	return typeof value === "string" && value.trim()
		? value.trim()
		: "goal_spec_approval";
}

function topLevelNodeIds(spec: unknown): string[] {
	const doList = (spec as { do?: unknown })?.do;
	if (!Array.isArray(doList)) return [];
	const ids: string[] = [];
	for (const entry of doList) {
		if (entry && typeof entry === "object") {
			for (const key of Object.keys(entry as Record<string, unknown>)) {
				ids.push(key);
			}
		}
	}
	return ids;
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

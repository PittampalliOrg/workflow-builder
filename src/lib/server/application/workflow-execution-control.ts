import type {
	WorkflowExecutionRecord,
	WorkflowApprovalEventPort,
	WorkflowDefinition,
	WorkflowDataService,
	WorkflowExecutionCoordinatorOwnerPort,
	WorkflowExecutionLifecycleControllerPort,
	WorkflowExecutionLifecycleStopMode,
	WorkflowExecutionReadModelPort,
	WorkflowRunStarterPort,
	WorkflowSpecValidatorPort,
} from "$lib/server/application/ports";

export type WorkflowExecutionControlInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
	body?: Record<string, unknown>;
};

export type WorkflowExecutionStartInput = {
	workflowId: string;
	userId: string;
	projectId?: string | null;
	body?: Record<string, unknown>;
};

export type WorkflowWebhookStartInput = {
	workflowId: string;
	authorizationHeader: string | null;
	body?: Record<string, unknown>;
};

export type WorkflowExecutionDetailInput = {
	executionId: string;
	userId?: string | null;
	projectId?: string | null;
};

export type WorkflowExecutionStatusInput = WorkflowExecutionDetailInput & {
	includeAgentEvents: boolean;
};

export type WorkflowExecutionApprovalStateInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

const STOP_MODES = new Set<WorkflowExecutionLifecycleStopMode>([
	"interrupt",
	"terminate",
	"purge",
	"reset",
]);

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
				| "getExecutionById"
				| "getScopedExecutionById"
				| "getWorkflowByRef"
				| "getRunningWorkflowExecution"
				| "validateApiKeyForUser"
			>;
			approvalEvents: WorkflowApprovalEventPort;
			coordinatorOwners: WorkflowExecutionCoordinatorOwnerPort;
			executionLifecycle: WorkflowExecutionLifecycleControllerPort;
			executionReadModels: WorkflowExecutionReadModelPort;
			runStarter: WorkflowRunStarterPort;
			workflowSpecs: WorkflowSpecValidatorPort;
		},
	) {}

	async executeWorkflow(
		input: WorkflowExecutionStartInput,
	): Promise<WorkflowExecutionControlResult> {
		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: input.workflowId,
			lookup: "id",
		});
		if (!isScopedResourceInScope(workflow, input)) {
			return workflowControlError(404, "Workflow not found");
		}

		const result = await this.deps.runStarter.startWorkflowRun({
			workflowId: input.workflowId,
			triggerData: asRecord(input.body?.input),
			userId: input.userId,
		});
		if (!result.ok) {
			return workflowControlError(result.status, result.error);
		}

		return {
			status: "ok",
			body: {
				executionId: result.executionId,
				instanceId: result.instanceId,
				workflowId: input.workflowId,
				status: "running",
			},
		};
	}

	async startWebhookExecution(
		input: WorkflowWebhookStartInput,
	): Promise<WorkflowExecutionControlResult> {
		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: input.workflowId,
			lookup: "id",
		});
		if (!workflow) {
			return workflowControlError(404, "Workflow not found");
		}

		const apiKeyValidation = await this.deps.workflowData.validateApiKeyForUser({
			authorizationHeader: input.authorizationHeader,
			userId: workflow.userId,
		});
		if (!apiKeyValidation.valid) {
			return workflowControlError(
				apiKeyValidation.statusCode || 401,
				apiKeyValidation.error,
			);
		}

		if (!hasWebhookTrigger(workflow)) {
			return workflowControlError(
				400,
				"This workflow is not configured for webhook triggers",
			);
		}

		if (!this.deps.workflowSpecs.isServerlessWorkflow(workflow.spec)) {
			return workflowControlError(
				400,
				"Workflow does not have a valid CNCF Serverless Workflow 1.0 spec",
			);
		}

		const runningExecution =
			await this.deps.workflowData.getRunningWorkflowExecution(input.workflowId);
		if (runningExecution) {
			return {
				status: "ok",
				httpStatus: 409,
				body: {
					error: "A workflow execution is already running",
					existingExecutionId: runningExecution.id,
				},
			};
		}

		const result = await this.deps.runStarter.startWorkflowRun({
			workflowId: input.workflowId,
			triggerData: asRecord(input.body),
			userId: workflow.userId,
			triggerSource: "webhook",
		});
		if (!result.ok) {
			return workflowControlError(result.status, result.error);
		}

		return {
			status: "ok",
			body: {
				executionId: result.executionId,
				status: "running",
			},
		};
	}

	async getExecutionStatus(
		input: WorkflowExecutionStatusInput,
	): Promise<WorkflowExecutionControlResult> {
		if (input.userId) {
			const execution = await this.deps.workflowData.getExecutionById(
				input.executionId,
			);
			if (
				!isExecutionInScope(execution, {
					userId: input.userId,
					projectId: input.projectId ?? null,
				})
			) {
				return workflowControlError(404, "Execution not found");
			}
		}

		try {
			const model = await this.deps.executionReadModels.loadExecutionReadModel({
				executionId: input.executionId,
				refreshRuntime: true,
				includeAgentEvents: input.includeAgentEvents,
			});
			if (!model) return workflowControlError(404, "Execution not found");

			return {
				status: "ok",
				body: this.deps.executionReadModels.serializeExecutionReadModel(model, {
					compact: false,
					includeAgentEvents: input.includeAgentEvents,
				}),
			};
		} catch (readModelError) {
			console.error(
				"[ExecutionStatus] execution read-model load failed:",
				readModelError,
			);
			return workflowControlError(
				503,
				readModelError instanceof Error
					? readModelError.message
					: "Execution read-model migration is required",
			);
		}
	}

	async stopExecution(
		input: WorkflowExecutionControlInput,
	): Promise<WorkflowExecutionControlResult> {
		const access = await this.deps.executionLifecycle.checkExecutionAccess({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (access.status !== "ok") {
			return workflowControlError(404, "Execution not found");
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
						owner.kind === "benchmarkRun"
							? "This is a benchmark instance — cancel the benchmark run instead."
							: "This is an evaluation instance — cancel the evaluation run instead.",
				},
			};
		}

		const result = await this.deps.executionLifecycle.stopExecution(
			input.executionId,
			{
				mode: parseStopMode(input.body?.mode),
				reason:
					typeof input.body?.reason === "string"
						? input.body.reason
						: undefined,
				graceMs:
					typeof input.body?.graceMs === "number"
						? input.body.graceMs
						: undefined,
			},
		);
		if (result.notFound) return workflowControlError(404, "Execution not found");

		const httpStatus =
			result.state === "confirmed" ? 200 : result.state === "stopping" ? 202 : 409;
		return {
			status: "ok",
			httpStatus,
			body: { ok: result.confirmed, ...result },
		};
	}

	async getStopStatus(
		input: WorkflowExecutionControlInput,
	): Promise<WorkflowExecutionControlResult> {
		const access = await this.deps.executionLifecycle.checkExecutionAccess({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (access.status !== "ok") {
			return workflowControlError(404, "Execution not found");
		}

		const result = await this.deps.executionLifecycle.confirmExecutionStop(
			input.executionId,
		);
		return { status: "ok", body: { state: result.state } };
	}

	async getExecutionDetail(
		input: WorkflowExecutionDetailInput,
	): Promise<WorkflowExecutionControlResult> {
		const execution = await this.deps.workflowData.getExecutionById(
			input.executionId,
		);
		if (!execution) {
			return workflowControlError(404, "Execution not found");
		}
		if (
			input.userId &&
			!isExecutionInScope(execution, {
				userId: input.userId,
				projectId: input.projectId ?? null,
			})
		) {
			return workflowControlError(404, "Execution not found");
		}

		const owner = await this.deps.coordinatorOwners.getCoordinatorOwner(
			input.executionId,
		);
		return {
			status: "ok",
			body: { ...execution, owner },
		};
	}

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

	async getApprovalState(
		input: WorkflowExecutionApprovalStateInput,
	): Promise<WorkflowExecutionControlResult> {
		const execution = await this.deps.workflowData.getScopedExecutionById({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (!execution) {
			return workflowControlError(404, "Execution not found");
		}

		if (
			!ACTIVE_APPROVAL_STATUSES.has(
				String(execution.status ?? "").toLowerCase(),
			)
		) {
			return { status: "ok", body: { awaiting: false } };
		}

		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: execution.workflowId,
			lookup: "id",
		});
		const gate = findListenGate(workflow?.spec, execution.currentNodeId);
		if (!gate) return { status: "ok", body: { awaiting: false } };

		return {
			status: "ok",
			body: {
				awaiting: true,
				nodeId: execution.currentNodeId,
				eventType: gate.eventType,
			},
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

const ACTIVE_APPROVAL_STATUSES = new Set(["running", "pending", "paused"]);

function findListenGate(
	spec: unknown,
	nodeId: string | null,
): { eventType: string } | null {
	if (!nodeId || typeof spec !== "object" || spec === null) return null;
	const doList = (spec as Record<string, unknown>).do;
	if (!Array.isArray(doList)) return null;
	for (const entry of doList) {
		if (typeof entry !== "object" || entry === null) continue;
		const key = Object.keys(entry as Record<string, unknown>)[0];
		if (key !== nodeId) continue;
		const node = (entry as Record<string, unknown>)[key] as Record<
			string,
			unknown
		>;
		const listen = node.listen as Record<string, unknown> | undefined;
		if (!listen) return null;
		const withType = (
			((listen.to as Record<string, unknown>)?.one as Record<string, unknown>)
				?.with as Record<string, unknown>
		)?.type;
		return {
			eventType: typeof withType === "string" && withType ? withType : nodeId,
		};
	}
	return null;
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

type ScopedResource = {
	userId: string;
	projectId: string | null;
};

function isScopedResourceInScope<T extends ScopedResource>(
	resource: T | null,
	input: { userId: string; projectId?: string | null },
): resource is T {
	if (!resource) return false;
	if (resource.projectId && input.projectId) {
		return resource.projectId === input.projectId;
	}
	if (!resource.projectId) {
		return resource.userId === input.userId;
	}
	return resource.userId === input.userId;
}

function isExecutionInScope(
	execution: WorkflowExecutionRecord | null,
	input: { userId: string; projectId?: string | null },
): execution is WorkflowExecutionRecord {
	return isScopedResourceInScope(execution, input);
}

function hasWebhookTrigger(workflow: WorkflowDefinition): boolean {
	const nodes = workflow.nodes as Array<{
		data?: { type?: string; config?: { triggerType?: string } };
	}>;
	return nodes.some(
		(node) =>
			node.data?.type === "trigger" &&
			node.data.config?.triggerType === "Webhook",
	);
}

function asRecord(value: unknown): Record<string, unknown> {
	return (value ?? {}) as Record<string, unknown>;
}

function parseStopMode(value: unknown): WorkflowExecutionLifecycleStopMode {
	return typeof value === "string" &&
		STOP_MODES.has(value as WorkflowExecutionLifecycleStopMode)
		? (value as WorkflowExecutionLifecycleStopMode)
		: "terminate";
}

function workflowControlError(
	httpStatus: number,
	message: string,
): WorkflowExecutionControlResult {
	return { status: "error", httpStatus, message };
}

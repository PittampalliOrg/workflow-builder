import type {
	CreateWorkflowDefinitionInput,
	UpdateWorkflowDefinitionInput,
	WorkflowConnectionRefSyncPort,
	WorkflowDefinition,
	WorkflowEngineType,
} from "$lib/server/application/ports";
import { getRemovedSw10AgentCallsError } from "$lib/server/workflows/sw10-agent-validation";
import { nanoid } from "nanoid";

type WorkflowDefinitionCommandDataPort = {
	createWorkflowDefinition(input: CreateWorkflowDefinitionInput): Promise<WorkflowDefinition>;
	updateWorkflowDefinition(
		id: string,
		input: UpdateWorkflowDefinitionInput,
	): Promise<WorkflowDefinition | null>;
	getWorkflowByRef(input: {
		workflowId: string;
		lookup: "id";
	}): Promise<WorkflowDefinition | null>;
	hasActiveWorkflowExecutions(id: string): Promise<boolean>;
	deleteWorkflowDefinition(id: string): Promise<void>;
};

export type WorkflowDefinitionCommandResult =
	| {
			status: "ok";
			httpStatus?: number;
			body: unknown;
	  }
	| {
			status: "error";
			httpStatus: number;
			body: string | Record<string, unknown>;
	  };

export class ApplicationWorkflowDefinitionCommandService {
	constructor(
		private readonly deps: {
			workflowData: WorkflowDefinitionCommandDataPort;
			connectionRefs: WorkflowConnectionRefSyncPort;
		},
	) {}

	async createWorkflow(input: {
		body: unknown;
		userId: string;
		projectId: string;
	}): Promise<WorkflowDefinitionCommandResult> {
		const body = asRecord(input.body);
		const createInput: CreateWorkflowDefinitionInput = {
			name: stringValue(body.name) || "Untitled Workflow",
			nodes: (body.nodes as unknown[] | undefined) || [],
			edges: (body.edges as unknown[] | undefined) || [],
			engineType: (stringValue(body.engineType) || "dapr") as WorkflowEngineType,
			userId: input.userId,
			projectId: input.projectId,
			spec: body.spec,
		};

		const workflow = await this.deps.workflowData.createWorkflowDefinition(createInput);
		await this.deps.connectionRefs.syncWorkflowConnectionRefs({
			workflowId: workflow.id,
			nodes: createInput.nodes,
			spec: body.spec,
		});

		return { status: "ok", httpStatus: 201, body: workflow };
	}

	async updateWorkflow(input: {
		workflowId: string;
		body: unknown;
	}): Promise<WorkflowDefinitionCommandResult> {
		const body = asRecord(input.body);
		const updateData: UpdateWorkflowDefinitionInput = {
			name: stringValue(body.name),
			nodes: body.nodes as unknown[] | undefined,
			edges: body.edges as unknown[] | undefined,
		};
		if (body.spec !== undefined) {
			updateData.spec = body.spec;
		}

		const updated = await this.deps.workflowData.updateWorkflowDefinition(
			input.workflowId,
			updateData,
		);
		if (!updated) {
			return { status: "error", httpStatus: 404, body: "Workflow not found" };
		}

		await this.deps.connectionRefs.syncWorkflowConnectionRefs({
			workflowId: input.workflowId,
			nodes: body.nodes,
			spec: updateData.spec,
		});

		return { status: "ok", body: updated };
	}

	async deleteWorkflow(input: {
		workflowId: string;
		userId: string;
		projectId?: string | null;
	}): Promise<WorkflowDefinitionCommandResult> {
		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: input.workflowId,
			lookup: "id",
		});
		if (!isResourceInScope(workflow, input)) {
			return { status: "error", httpStatus: 404, body: "Workflow not found" };
		}

		if (await this.deps.workflowData.hasActiveWorkflowExecutions(input.workflowId)) {
			return {
				status: "error",
				httpStatus: 409,
				body: "Stop the running execution before deleting this workflow",
			};
		}

		try {
			await this.deps.workflowData.deleteWorkflowDefinition(input.workflowId);
		} catch (err) {
			if ((err as { code?: string })?.code === "23503") {
				return {
					status: "error",
					httpStatus: 409,
					body:
						"This workflow has execution history and cannot be deleted; archive it instead.",
				};
			}
			throw err;
		}

		return { status: "ok", body: { success: true } };
	}

	async publishWorkflow(input: {
		workflowId: string;
	}): Promise<WorkflowDefinitionCommandResult> {
		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: input.workflowId,
			lookup: "id",
		});
		if (!workflow) {
			return { status: "error", httpStatus: 404, body: "Workflow not found" };
		}

		const versionId = `pub_${Date.now()}_${nanoid(6).toLowerCase()}`;
		const daprWorkflowName = workflow.daprWorkflowName || `wf_${workflow.id}`;
		const spec = asRecord(workflow.spec);
		const removedAgentCallsError = getRemovedSw10AgentCallsError(spec);
		if (removedAgentCallsError) {
			return { status: "error", httpStatus: 400, body: removedAgentCallsError };
		}

		const revision = {
			version: versionId,
			publishedAt: new Date().toISOString(),
			nodes: structuredClone(workflow.nodes),
			edges: structuredClone(workflow.edges),
			name: workflow.name,
			description: workflow.description,
		};

		const metadata = asRecord(spec.metadata);
		const publishedRuntime = asRecord(metadata.publishedRuntime);
		const existingRevisions = Array.isArray(publishedRuntime.revisions)
			? publishedRuntime.revisions
			: [];
		const updated = await this.deps.workflowData.updateWorkflowDefinition(
			input.workflowId,
			{
				spec: {
					...spec,
					metadata: {
						...metadata,
						publishedRuntime: {
							...publishedRuntime,
							latestVersion: versionId,
							revisions: [...existingRevisions, revision],
						},
					},
				},
				daprWorkflowName,
			},
		);

		return { status: "ok", body: updated };
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function isResourceInScope(
	resource: Pick<WorkflowDefinition, "userId" | "projectId"> | null | undefined,
	session: { userId: string; projectId?: string | null },
): resource is Pick<WorkflowDefinition, "userId" | "projectId"> {
	if (!resource) return false;
	if (resource.projectId && session.projectId) {
		return resource.projectId === session.projectId;
	}
	if (!resource.projectId) {
		return resource.userId === session.userId;
	}
	return resource.userId === session.userId;
}

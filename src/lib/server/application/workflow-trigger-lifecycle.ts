import type { WorkflowTriggerLifecyclePort } from "$lib/server/application/ports";

type ScopedWorkflowRecord = {
	userId: string;
	projectId: string | null;
};

type WorkflowTriggerDataPort = {
	getWorkflowByRef(input: {
		workflowId: string;
		lookup: "id";
	}): Promise<ScopedWorkflowRecord | null>;
	getWorkflowTrigger(input: {
		workflowId: string;
		triggerId: string;
	}): Promise<unknown | null>;
	deleteWorkflowTrigger(triggerId: string): Promise<void>;
};

export type WorkflowTriggerLifecycleCommandResult =
	| {
			status: "ok";
			httpStatus?: number;
			body: Record<string, unknown>;
	  }
	| {
			status: "error";
			httpStatus: number;
			body: string | Record<string, unknown>;
	  };

export type WorkflowTriggerLifecycleCommandInput = {
	workflowId: string;
	triggerId: string;
	userId: string;
	projectId?: string | null;
};

export class ApplicationWorkflowTriggerLifecycleService {
	constructor(
		private readonly deps: {
			workflowData: WorkflowTriggerDataPort;
			lifecycle: WorkflowTriggerLifecyclePort;
		},
	) {}

	async activateTrigger(
		input: WorkflowTriggerLifecycleCommandInput,
	): Promise<WorkflowTriggerLifecycleCommandResult> {
		const scoped = await this.ensureScopedTrigger(input);
		if (scoped.status === "error") return scoped;

		const result = await this.deps.lifecycle.activateTrigger(input.triggerId);
		if (!result.ok) {
			return {
				status: "error",
				httpStatus: 502,
				body: { error: result.error },
			};
		}

		return {
			status: "ok",
			body: { success: true, status: result.status },
		};
	}

	async deactivateTrigger(
		input: WorkflowTriggerLifecycleCommandInput,
	): Promise<WorkflowTriggerLifecycleCommandResult> {
		const scoped = await this.ensureScopedTrigger(input);
		if (scoped.status === "error") return scoped;

		const result = await this.deps.lifecycle.deactivateTrigger(input.triggerId);
		if (!result.ok) {
			return {
				status: "error",
				httpStatus: 502,
				body: { error: result.error },
			};
		}

		return {
			status: "ok",
			body: { success: true, status: result.status },
		};
	}

	async deleteTrigger(
		input: WorkflowTriggerLifecycleCommandInput,
	): Promise<WorkflowTriggerLifecycleCommandResult> {
		const scoped = await this.ensureScopedTrigger(input);
		if (scoped.status === "error") return scoped;

		await this.deps.lifecycle.deactivateTrigger(input.triggerId);
		await this.deps.workflowData.deleteWorkflowTrigger(input.triggerId);

		return {
			status: "ok",
			body: { success: true },
		};
	}

	private async ensureScopedTrigger(
		input: WorkflowTriggerLifecycleCommandInput,
	): Promise<{ status: "ok" } | WorkflowTriggerLifecycleCommandResult> {
		const workflow = await this.deps.workflowData.getWorkflowByRef({
			workflowId: input.workflowId,
			lookup: "id",
		});
		if (!isResourceInScope(workflow, input)) {
			return {
				status: "error",
				httpStatus: 404,
				body: "Workflow not found",
			};
		}

		const trigger = await this.deps.workflowData.getWorkflowTrigger({
			workflowId: input.workflowId,
			triggerId: input.triggerId,
		});
		if (!trigger) {
			return {
				status: "error",
				httpStatus: 404,
				body: "Trigger not found",
			};
		}

		return { status: "ok" };
	}
}

function isResourceInScope(
	resource: ScopedWorkflowRecord | null | undefined,
	session: { userId: string; projectId?: string | null },
): resource is ScopedWorkflowRecord {
	if (!resource) return false;
	if (resource.projectId && session.projectId) {
		return resource.projectId === session.projectId;
	}
	if (!resource.projectId) {
		return resource.userId === session.userId;
	}
	return resource.userId === session.userId;
}

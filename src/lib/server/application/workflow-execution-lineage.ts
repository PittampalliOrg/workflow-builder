import type {
	WorkflowDataService,
	WorkflowExecutionLineage,
} from "$lib/server/application/ports";

export type WorkflowExecutionLineageInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

export type WorkflowExecutionLineageResult =
	| {
			status: "ok";
			body: WorkflowExecutionLineage;
	  }
	| { status: "error"; httpStatus: number; message: string };

export class ApplicationWorkflowExecutionLineageService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				"getScopedExecutionById" | "getExecutionLineage"
			>;
		},
	) {}

	async getLineage(
		input: WorkflowExecutionLineageInput,
	): Promise<WorkflowExecutionLineageResult> {
		const execution = await this.deps.workflowData.getScopedExecutionById({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
		if (!execution) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Execution not found",
			};
		}

		const lineage = await this.deps.workflowData.getExecutionLineage(
			input.executionId,
		);
		if (!lineage) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Execution not found",
			};
		}

		return { status: "ok", body: lineage };
	}
}

import type {
	WorkflowBrowserArtifactRecord,
	WorkflowDataService,
} from "$lib/server/application/ports";

export type WorkflowBrowserArtifactsInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

export type WorkflowBrowserArtifactsResult =
	| {
			status: "ok";
			body: { artifacts: WorkflowBrowserArtifactRecord[] };
	  }
	| { status: "error"; httpStatus: number; message: string };

export class ApplicationWorkflowBrowserArtifactsService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				"getScopedExecutionById" | "listWorkflowBrowserArtifactsByExecutionId"
			>;
		},
	) {}

	async listArtifacts(
		input: WorkflowBrowserArtifactsInput,
	): Promise<WorkflowBrowserArtifactsResult> {
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

		return {
			status: "ok",
			body: {
				artifacts:
					await this.deps.workflowData.listWorkflowBrowserArtifactsByExecutionId(
						input.executionId,
					),
			},
		};
	}
}

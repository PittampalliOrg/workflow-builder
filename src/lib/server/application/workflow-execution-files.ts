import type {
	WorkflowDataService,
	WorkflowExecutionOutputFiles,
} from "$lib/server/application/ports";

export type WorkflowExecutionFilesInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

export type WorkflowExecutionFilesResult =
	| {
			status: "ok";
			body: WorkflowExecutionOutputFiles;
	  }
	| { status: "error"; httpStatus: number; message: string };

export class ApplicationWorkflowExecutionFilesService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				"getScopedExecutionById" | "listExecutionOutputFiles"
			>;
		},
	) {}

	async listOutputFiles(
		input: WorkflowExecutionFilesInput,
	): Promise<WorkflowExecutionFilesResult> {
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
			body: await this.deps.workflowData.listExecutionOutputFiles(
				input.executionId,
			),
		};
	}
}

import type {
	WorkflowArtifactRecord,
	WorkflowDataService,
} from "$lib/server/application/ports";

export type WorkflowExecutionArtifactsInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

export type WorkflowExecutionArtifactsResult =
	| { status: "ok"; body: { artifacts: WorkflowArtifactRecord[] } }
	| { status: "error"; httpStatus: number; message: string };

export class ApplicationWorkflowExecutionArtifactsService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				"getScopedExecutionById" | "listWorkflowArtifactsByExecutionId"
			>;
		},
	) {}

	async listArtifacts(
		input: WorkflowExecutionArtifactsInput,
	): Promise<WorkflowExecutionArtifactsResult> {
		let execution;
		try {
			execution = await this.deps.workflowData.getScopedExecutionById({
				executionId: input.executionId,
				userId: input.userId,
				projectId: input.projectId ?? null,
			});
		} catch (err) {
			console.error("[WorkflowArtifacts] execution lookup failed:", err);
			return {
				status: "error",
				httpStatus: 503,
				message: err instanceof Error ? err.message : "Execution lookup failed",
			};
		}

		if (!execution) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Execution not found",
			};
		}

		try {
			return {
				status: "ok",
				body: {
					artifacts:
						await this.deps.workflowData.listWorkflowArtifactsByExecutionId(
							input.executionId,
						),
				},
			};
		} catch (err) {
			console.error("[WorkflowArtifacts] artifact list failed:", err);
			return {
				status: "error",
				httpStatus: 503,
				message: err instanceof Error ? err.message : "Artifact lookup failed",
			};
		}
	}
}

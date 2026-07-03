import type {
	WorkflowArtifactRecord,
	WorkflowDataService,
	WorkflowFileRecord,
} from "$lib/server/application/ports";

export type WorkflowExecutionArtifactDiffInput = {
	executionId: string;
	artifactId: string;
	userId: string;
	projectId?: string | null;
};

export type WorkflowExecutionArtifactDiffStats = {
	files: number;
	additions: number;
	deletions: number;
};

export type WorkflowExecutionArtifactDiffBody = {
	patch: string;
	baseRef: string | null;
	headRef: string | null;
	stats: WorkflowExecutionArtifactDiffStats;
	truncated: boolean;
};

export type WorkflowExecutionArtifactDiffResult =
	| { status: "ok"; body: WorkflowExecutionArtifactDiffBody }
	| { status: "error"; httpStatus: number; message: string };

export type WorkflowExecutionArtifactDiffResolver = (
	artifact: WorkflowArtifactRecord,
	fileStore: {
		getFileContent(
			id: string,
		): Promise<{ summary: WorkflowFileRecord; bytes: Buffer } | null>;
	},
) => Promise<WorkflowExecutionArtifactDiffBody | null>;

export class ApplicationWorkflowExecutionArtifactDiffService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				| "getScopedExecutionById"
				| "getWorkflowArtifactForExecution"
				| "getWorkflowFileContent"
			>;
			diffKind: string;
			resolveDiff: WorkflowExecutionArtifactDiffResolver;
		},
	) {}

	async getDiff(
		input: WorkflowExecutionArtifactDiffInput,
	): Promise<WorkflowExecutionArtifactDiffResult> {
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

		const artifact = await this.deps.workflowData.getWorkflowArtifactForExecution({
			executionId: input.executionId,
			artifactId: input.artifactId,
		});
		if (!artifact || artifact.kind !== this.deps.diffKind) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Diff artifact not found",
			};
		}

		const resolved = await this.deps.resolveDiff(artifact, {
			getFileContent:
				this.deps.workflowData.getWorkflowFileContent.bind(this.deps.workflowData),
		});
		if (!resolved) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Diff artifact not found",
			};
		}

		return { status: "ok", body: resolved };
	}
}

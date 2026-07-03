import type {
	WorkflowDataService,
	WorkflowExecutionRecord,
	WorkflowExecutionWorkspaceFile,
	WorkflowExecutionWorkspacePort,
	WorkflowExecutionWorkspaceTree,
} from "$lib/server/application/ports";

export type WorkflowExecutionWorkspaceInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

export type WorkflowExecutionWorkspaceFileInput =
	WorkflowExecutionWorkspaceInput & {
		path: string;
	};

export type WorkflowExecutionWorkspaceTreeResult =
	| {
			status: "ok";
			body: WorkflowExecutionWorkspaceTree;
	  }
	| { status: "error"; httpStatus: number; message: string };

export type WorkflowExecutionWorkspaceFileResult =
	| {
			status: "ok";
			body: WorkflowExecutionWorkspaceFile;
	  }
	| { status: "error"; httpStatus: number; message: string };

export class ApplicationWorkflowExecutionWorkspaceService {
	constructor(
		private readonly deps: {
			workflowData: Pick<WorkflowDataService, "getScopedExecutionById">;
			workspace: WorkflowExecutionWorkspacePort;
		},
	) {}

	async listWorkspaceFiles(
		input: WorkflowExecutionWorkspaceInput,
	): Promise<WorkflowExecutionWorkspaceTreeResult> {
		const execution = await this.getScopedExecution(input);
		if (!execution) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Execution not found",
			};
		}
		if (!execution.daprInstanceId) {
			return emptyWorkspaceTree();
		}

		try {
			return {
				status: "ok",
				body: await this.deps.workspace.listTree(execution.daprInstanceId),
			};
		} catch (err) {
			console.error("[workspace-files] webdav error:", err);
			return {
				status: "ok",
				body: {
					entries: [],
					truncated: false,
					error: "workspace unavailable",
				},
			};
		}
	}

	async readWorkspaceFile(
		input: WorkflowExecutionWorkspaceFileInput,
	): Promise<WorkflowExecutionWorkspaceFileResult> {
		const execution = await this.getScopedExecution(input);
		if (!execution) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Execution not found",
			};
		}
		if (!execution.daprInstanceId) {
			return {
				status: "error",
				httpStatus: 404,
				message: "Run has no workspace",
			};
		}

		const file = await this.deps.workspace.readFile(
			execution.daprInstanceId,
			input.path,
		);
		if (!file) {
			return { status: "error", httpStatus: 404, message: "File not found" };
		}
		return { status: "ok", body: file };
	}

	private getScopedExecution(input: WorkflowExecutionWorkspaceInput) {
		return this.deps.workflowData.getScopedExecutionById({
			executionId: input.executionId,
			userId: input.userId,
			projectId: input.projectId ?? null,
		});
	}
}

function emptyWorkspaceTree(): WorkflowExecutionWorkspaceTreeResult {
	return {
		status: "ok",
		body: { entries: [], truncated: false },
	};
}

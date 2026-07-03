import type {
	WorkflowDataService,
	WorkflowExecutionSessionSummary,
} from "$lib/server/application/ports";

export type WorkflowExecutionSessionsInput = {
	executionId: string;
	userId: string;
	projectId?: string | null;
};

export type WorkflowExecutionSessionListItem = {
	id: string;
	title: string | null;
	status: string | null;
	agentId: string | null;
	inherited: boolean;
	sourceExecutionId: string | null;
	createdAt: string | null;
	completedAt: string | null;
};

export type WorkflowExecutionSessionsResult =
	| {
			status: "ok";
			body: { sessions: WorkflowExecutionSessionListItem[] };
	  }
	| { status: "error"; httpStatus: number; message: string };

export class ApplicationWorkflowExecutionSessionsService {
	constructor(
		private readonly deps: {
			workflowData: Pick<
				WorkflowDataService,
				"getScopedExecutionById" | "listExecutionSessions"
			>;
		},
	) {}

	async listSessions(
		input: WorkflowExecutionSessionsInput,
	): Promise<WorkflowExecutionSessionsResult> {
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

		const rows = await this.deps.workflowData.listExecutionSessions({
			executionId: input.executionId,
			projectId: input.projectId ?? null,
			includeAncestors: true,
		});

		return {
			status: "ok",
			body: { sessions: rows.map((row) => toSessionItem(row, input.executionId)) },
		};
	}
}

function toSessionItem(
	row: WorkflowExecutionSessionSummary,
	executionId: string,
): WorkflowExecutionSessionListItem {
	const inherited = row.workflowExecutionId !== executionId;
	return {
		id: row.id,
		title: row.title,
		status: row.status,
		agentId: row.agentId,
		inherited,
		sourceExecutionId: inherited ? row.workflowExecutionId : null,
		createdAt: row.createdAt?.toISOString() ?? null,
		completedAt: row.completedAt?.toISOString() ?? null,
	};
}

import type {
	LegacyAgentPlanReaderPort,
	WorkflowPlanArtifactStore,
} from "$lib/server/application/ports";

export type WorkflowExecutionPlanReadModel = {
	plan: string | null;
};

export class ApplicationWorkflowPlanService {
	constructor(
		private readonly deps: {
			planArtifacts: Pick<WorkflowPlanArtifactStore, "listPlanArtifactsByExecutionId">;
			legacyAgentPlans: LegacyAgentPlanReaderPort;
		},
	) {}

	async getExecutionPlan(input: {
		executionId: string;
	}): Promise<WorkflowExecutionPlanReadModel> {
		let artifacts;
		try {
			artifacts = await this.deps.planArtifacts.listPlanArtifactsByExecutionId(
				input.executionId,
			);
		} catch {
			return { plan: null };
		}

		const [artifact] = artifacts;
		if (artifact?.planMarkdown) {
			return { plan: artifact.planMarkdown };
		}

		try {
			return { plan: await this.deps.legacyAgentPlans.getPlan(input.executionId) };
		} catch {
			return { plan: null };
		}
	}
}

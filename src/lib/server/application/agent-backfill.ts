export type AgentInlineBackfillReport = {
	agentsCreated: number;
	agentsReused: number;
	nodesRewritten: number;
	workflowsTouched: number;
	workflowsScanned: number;
};

export type AgentInlineBackfillRepository = {
	backfillInlineAgents(): Promise<AgentInlineBackfillReport>;
};

export class ApplicationAgentBackfillService {
	constructor(private readonly repository: AgentInlineBackfillRepository) {}

	backfillInlineAgents(): Promise<AgentInlineBackfillReport> {
		return this.repository.backfillInlineAgents();
	}
}

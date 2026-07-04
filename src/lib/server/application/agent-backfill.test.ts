import { describe, expect, it, vi } from "vitest";
import {
	ApplicationAgentBackfillService,
	type AgentInlineBackfillRepository,
} from "$lib/server/application/agent-backfill";

describe("ApplicationAgentBackfillService", () => {
	it("delegates inline-agent migration to the repository port", async () => {
		const repository: AgentInlineBackfillRepository = {
			backfillInlineAgents: vi.fn(async () => ({
				agentsCreated: 1,
				agentsReused: 2,
				nodesRewritten: 3,
				workflowsTouched: 4,
				workflowsScanned: 5,
			})),
		};
		const service = new ApplicationAgentBackfillService(repository);

		await expect(service.backfillInlineAgents()).resolves.toEqual({
			agentsCreated: 1,
			agentsReused: 2,
			nodesRewritten: 3,
			workflowsTouched: 4,
			workflowsScanned: 5,
		});
		expect(repository.backfillInlineAgents).toHaveBeenCalledOnce();
	});
});

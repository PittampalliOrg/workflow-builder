import { describe, expect, it } from "vitest";
import type { ActionDefinition } from "@/lib/actions/types";
import type { WorkflowSpecCatalog } from "@/lib/workflow-spec/catalog";
import { buildRelevantActionListPrompt } from "./action-list-prompt";

const workspaceCloneAction: ActionDefinition = {
	id: "workspace/clone",
	integration: "workspace",
	slug: "clone",
	label: "Workspace Clone Repository",
	description: "Clone a repository into a workspace",
	category: "Workspace",
	configFields: [],
	outputFields: [],
};

describe("buildRelevantActionListPrompt", () => {
	it("uses a realistic workspace/clone example", () => {
		const catalog: WorkflowSpecCatalog = {
			integrations: [],
			actionsById: new Map([[workspaceCloneAction.id, workspaceCloneAction]]),
			integrationLabels: {},
		};
		const prompt = buildRelevantActionListPrompt({
			catalog,
			prompt: "clone a github repository into a workspace",
		});

		expect(prompt).toContain('"actionType":"workspace/clone"');
		expect(prompt).toContain('"repositoryOwner":"PittampalliOrg"');
		expect(prompt).toContain('"repositoryRepo":"workflow-builder"');
		expect(prompt).toContain('"repositoryBranch":"main"');
	});
});

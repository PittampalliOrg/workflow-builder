import { describe, expect, it } from "vitest";
import type { ActionDefinition } from "@/lib/actions/types";
import type { WorkflowSpecCatalog } from "./catalog";
import { lintWorkflowSpec } from "./lint";
import { WORKFLOW_SPEC_API_VERSION, type WorkflowSpec } from "./types";

const workspaceCloneAction: ActionDefinition = {
	id: "workspace/clone",
	integration: "workspace",
	slug: "clone",
	label: "Workspace Clone Repository",
	description: "Clone a repository into a workspace",
	category: "Workspace",
	configFields: [
		{
			key: "workspaceRef",
			label: "Workspace Ref",
			type: "template-input",
			required: true,
		},
		{
			key: "repositoryOwner",
			label: "Repository Owner",
			type: "template-input",
			required: false,
		},
		{
			key: "repositoryRepo",
			label: "Repository Repo",
			type: "template-input",
			required: false,
		},
		{
			key: "repositoryBranch",
			label: "Repository Branch",
			type: "template-input",
			required: true,
		},
		{
			key: "repositoryUrl",
			label: "Repository URL",
			type: "template-input",
			required: false,
		},
	],
	outputFields: [],
};

const catalog: WorkflowSpecCatalog = {
	integrations: [],
	actionsById: new Map([[workspaceCloneAction.id, workspaceCloneAction]]),
	integrationLabels: {},
};

function makeCloneSpec(config: Record<string, unknown>): WorkflowSpec {
	return {
		apiVersion: WORKFLOW_SPEC_API_VERSION,
		name: "Clone Workflow",
		trigger: {
			id: "trigger",
			type: "manual",
			config: { triggerType: "Manual" },
			next: "clone_repo",
		},
		steps: [
			{
				id: "clone_repo",
				kind: "action",
				label: "Clone Repo",
				enabled: true,
				config: {
					actionType: "workspace/clone",
					workspaceRef: "workspace-ref",
					...config,
				},
			},
		],
	};
}

describe("lintWorkflowSpec workspace/clone validation", () => {
	it("rejects missing repository source", () => {
		const { result } = lintWorkflowSpec(
			makeCloneSpec({
				repositoryBranch: "{{@trigger:Manual.branch}}",
			}),
			{ catalog, unknownActionType: "error" },
		);

		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "MISSING_CLONE_SOURCE",
				}),
			]),
		);
	});

	it("rejects missing repository branch", () => {
		const { result } = lintWorkflowSpec(
			makeCloneSpec({
				repositoryOwner: "{{@trigger:Manual.repo_owner}}",
				repositoryRepo: "{{@trigger:Manual.repo_name}}",
			}),
			{ catalog, unknownActionType: "error" },
		);

		expect(result.errors).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "MISSING_CLONE_BRANCH",
				}),
			]),
		);
	});

	it("accepts owner/repo/branch clone config", () => {
		const { result } = lintWorkflowSpec(
			makeCloneSpec({
				repositoryOwner: "{{@trigger:Manual.repo_owner}}",
				repositoryRepo: "{{@trigger:Manual.repo_name}}",
				repositoryBranch: "{{@trigger:Manual.branch}}",
			}),
			{ catalog, unknownActionType: "error" },
		);

		expect(result.errors).toHaveLength(0);
	});
});

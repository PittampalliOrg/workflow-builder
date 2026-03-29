import type { WorkflowTemplate } from "./coding-workflow";

export function buildOpenShellSessionWorkflow(): WorkflowTemplate {
	const triggerId = "trigger-session";
	const workspaceProfileId = "workspace-profile";
	const cloneId = "workspace-clone";
	const sessionStartId = "openshell-session-start";

	const repositoryOwnerTemplate = `{{@${triggerId}:Manual Trigger.repository_owner}}`;
	const repositoryRepoTemplate = `{{@${triggerId}:Manual Trigger.repository_repo}}`;
	const repositoryBranchTemplate = `{{@${triggerId}:Manual Trigger.repository_branch}}`;

	return {
		nodes: [
			{
				id: triggerId,
				type: "trigger",
				label: "Manual Trigger",
				description:
					"Provide the repository and initial prompt for the Claude session.",
				position: { x: 400, y: 0 },
				config: {
					triggerType: "Manual",
					inputSchema: JSON.stringify([
						{
							name: "repository_owner",
							type: "TEXT",
							required: true,
							description: "GitHub owner or organization.",
						},
						{
							name: "repository_repo",
							type: "TEXT",
							required: true,
							description: "GitHub repository name.",
						},
						{
							name: "repository_branch",
							type: "TEXT",
							required: true,
							description: "Branch to clone and open in the sandbox.",
						},
						{
							name: "initial_prompt",
							type: "TEXT",
							required: true,
							description:
								"First prompt Claude should run to initialize the session for handoff.",
						},
					]),
				},
			},
			{
				id: workspaceProfileId,
				type: "action",
				label: "Workspace Profile",
				description: "Create an execution-scoped workspace session.",
				position: { x: 400, y: 150 },
				config: {
					actionType: "workspace/profile",
					name: "openshell-claude-session",
					enabledTools: JSON.stringify(["read", "list", "bash"]),
					requireReadBeforeWrite: "false",
					commandTimeoutMs: "120000",
				},
			},
			{
				id: cloneId,
				type: "action",
				label: "Workspace Clone",
				description: "Clone the selected repository into the workspace.",
				position: { x: 400, y: 300 },
				config: {
					actionType: "workspace/clone",
					workspaceRef: "{{@workspace-profile:Workspace Profile.workspaceRef}}",
					repositoryOwner: repositoryOwnerTemplate,
					repositoryRepo: repositoryRepoTemplate,
					repositoryBranch: repositoryBranchTemplate,
					targetDir: repositoryRepoTemplate,
				},
			},
			{
				id: sessionStartId,
				type: "action",
				label: "OpenShell Session Start",
				description: "Provision a sandbox and initialize a Claude session.",
				position: { x: 400, y: 450 },
				config: {
					actionType: "openshell/session-start",
					workspaceRef: "{{@workspace-profile:Workspace Profile.workspaceRef}}",
					prompt: "{{@trigger-session:Manual Trigger.initial_prompt}}",
					repositoryUrl: `https://github.com/${repositoryOwnerTemplate}/${repositoryRepoTemplate}.git`,
					repositoryBranch: repositoryBranchTemplate,
					sandboxRepoPath: "/sandbox/repo",
					cwd: "{{@workspace-clone:Workspace Clone.clonePath}}",
					provider: "claude",
					model: "anthropic/claude-sonnet-4-6",
					keepSandbox: "true",
					timeoutMinutes: "15",
				},
			},
		],
		edges: [
			{
				id: "e-trigger-profile",
				source: triggerId,
				target: workspaceProfileId,
			},
			{ id: "e-profile-clone", source: workspaceProfileId, target: cloneId },
			{ id: "e-clone-session", source: cloneId, target: sessionStartId },
		],
	};
}

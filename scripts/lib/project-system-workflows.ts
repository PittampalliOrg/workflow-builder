import { createHash } from "node:crypto";

export type ProjectSystemWorkflowOwner = Readonly<{
	projectId: string;
	userId: string;
}>;

export type ProjectSystemWorkflowInstallation = ProjectSystemWorkflowOwner &
	Readonly<{
		workflowId: string;
	}>;

/**
 * Plan deterministic project-local copies of a canonical system workflow.
 * The canonical seed project keeps the stable base id; every other project
 * receives an opaque id so workflow/project authorization remains unchanged.
 */
export function planProjectSystemWorkflowInstallations(input: {
	baseWorkflowId: string;
	canonicalProjectId: string;
	owners: readonly ProjectSystemWorkflowOwner[];
}): ProjectSystemWorkflowInstallation[] {
	const owners = new Map<string, string>();
	for (const owner of input.owners) {
		const projectId = owner.projectId.trim();
		const userId = owner.userId.trim();
		if (!projectId || !userId || projectId === input.canonicalProjectId) continue;
		const current = owners.get(projectId);
		if (!current || userId < current) owners.set(projectId, userId);
	}

	return [...owners.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([projectId, userId]) => ({
			projectId,
			userId,
			workflowId: `${input.baseWorkflowId}-${createHash("sha256")
				.update(`${input.baseWorkflowId}\0${projectId}`, "utf8")
				.digest("hex")
				.slice(0, 20)}`,
		}));
}

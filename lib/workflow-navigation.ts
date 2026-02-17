type WorkflowRedirectCandidate = {
	id: string;
	name?: string;
	updatedAt: string;
};

const INTERNAL_WORKFLOW_NAMES = new Set(["__current__", "~~__CURRENT__~~"]);

function getUpdatedAtValue(updatedAt: string): number {
	const timestamp = new Date(updatedAt).getTime();
	return Number.isNaN(timestamp) ? 0 : timestamp;
}

export function getNavigableWorkflows<T extends WorkflowRedirectCandidate>(
	workflows: T[],
): T[] {
	return workflows.filter((workflow) => {
		if (!workflow.name) {
			return true;
		}
		return !INTERNAL_WORKFLOW_NAMES.has(workflow.name);
	});
}

export function pickWorkflowRedirectId(
	workflows: WorkflowRedirectCandidate[],
	preferredWorkflowId: string | null,
): string | null {
	if (workflows.length === 0) {
		return null;
	}

	if (preferredWorkflowId) {
		const matchingWorkflow = workflows.find(
			(workflow) => workflow.id === preferredWorkflowId,
		);
		if (matchingWorkflow) {
			return matchingWorkflow.id;
		}
	}

	const mostRecentWorkflow = [...workflows].sort(
		(a, b) => getUpdatedAtValue(b.updatedAt) - getUpdatedAtValue(a.updatedAt),
	)[0];

	return mostRecentWorkflow?.id ?? null;
}

export const LAST_SELECTED_WORKFLOW_ID_KEY =
	"workflow-builder:last-selected-workflow-id";

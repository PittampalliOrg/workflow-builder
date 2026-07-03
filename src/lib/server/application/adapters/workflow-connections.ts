import type { WorkflowConnectionRefSyncPort } from "$lib/server/application/ports";
import { syncWorkflowConnectionRefs } from "$lib/server/workflow-connections";

export class LegacyWorkflowConnectionRefSyncPort implements WorkflowConnectionRefSyncPort {
	syncWorkflowConnectionRefs(input: {
		workflowId: string;
		nodes: unknown;
		spec?: unknown;
	}) {
		return syncWorkflowConnectionRefs(input.workflowId, input.nodes, input.spec);
	}
}

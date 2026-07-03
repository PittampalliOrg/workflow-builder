import type { WorkflowConnectionRefSyncPort } from "$lib/server/application/ports";
import { eq } from "drizzle-orm";

import { db } from "$lib/server/db";
import { workflowConnectionRefs } from "$lib/server/db/schema";
import { collectWorkflowConnectionRefs } from "$lib/server/workflow-connections";

export class PostgresWorkflowConnectionRefSyncPort implements WorkflowConnectionRefSyncPort {
	async syncWorkflowConnectionRefs(input: {
		workflowId: string;
		nodes: unknown;
		spec?: unknown;
	}): Promise<void> {
		if (!db) return;
		const refs = collectWorkflowConnectionRefs(input.workflowId, input.nodes, input.spec);

		await db
			.delete(workflowConnectionRefs)
			.where(eq(workflowConnectionRefs.workflowId, input.workflowId));
		if (refs.length === 0) return;

		await db.insert(workflowConnectionRefs).values(refs);
	}
}

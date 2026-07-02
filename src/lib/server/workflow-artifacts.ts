/**
 * Workflow artifacts read helpers.
 *
 * Reads the generic `workflow_artifacts` table for the run-detail UI snapshot.
 */
import { getApplicationAdapters } from '$lib/server/application';
import type { WorkflowArtifactRecord as ApplicationWorkflowArtifactRecord } from '$lib/server/application/ports';

export type WorkflowArtifactRecord = {
	id: string;
	nodeId: string | null;
	slot: 'primary' | 'secondary' | 'aux' | null;
	kind: string;
	title: string;
	description: string | null;
	inlinePayload: unknown;
	fileId: string | null;
	contentType: string | null;
	sizeBytes: number | null;
	metadata: Record<string, unknown> | null;
	createdAt: string;
};

function rowToRecord(row: ApplicationWorkflowArtifactRecord): WorkflowArtifactRecord {
	return {
		id: row.id,
		nodeId: row.nodeId,
		slot: row.slot ?? null,
		kind: row.kind,
		title: row.title,
		description: row.description,
		inlinePayload: row.inlinePayload,
		fileId: row.fileId,
		contentType: row.contentType,
		sizeBytes: row.sizeBytes,
		metadata: row.metadata,
		createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt)
	};
}

export async function listWorkflowArtifactsByExecutionId(
	workflowExecutionId: string
): Promise<WorkflowArtifactRecord[]> {
	const rows = await getApplicationAdapters().artifactStore.listWorkflowArtifactsByExecutionId(
		workflowExecutionId
	);
	return rows.map(rowToRecord);
}

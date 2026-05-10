/**
 * Workflow artifacts read helpers.
 *
 * Mirrors `browser-artifacts.ts:listBrowserArtifactsByExecutionId` but for the
 * generic `workflow_artifacts` table — feeds the run-detail UI's snapshot.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflowArtifacts, type WorkflowArtifactRow } from '$lib/server/db/schema';

const SLOT_RANK = sql<number>`CASE ${workflowArtifacts.slot}
	WHEN 'primary' THEN 0
	WHEN 'secondary' THEN 1
	WHEN 'aux' THEN 2
	ELSE 3
END`;

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

function rowToRecord(row: WorkflowArtifactRow): WorkflowArtifactRecord {
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
	if (!db) throw new Error('Database not configured');
	const rows = await db
		.select()
		.from(workflowArtifacts)
		.where(eq(workflowArtifacts.workflowExecutionId, workflowExecutionId))
		.orderBy(SLOT_RANK, asc(workflowArtifacts.createdAt));
	return rows.map(rowToRecord);
}

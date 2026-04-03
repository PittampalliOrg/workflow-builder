import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/server/db';
import { workflows } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

export const POST: RequestHandler = async ({ params }) => {
	if (!db) return error(503, 'Database not configured');

	const [workflow] = await db
		.select()
		.from(workflows)
		.where(eq(workflows.id, params.workflowId))
		.limit(1);

	if (!workflow) {
		return error(404, 'Workflow not found');
	}

	const versionId = `pub_${Date.now()}_${nanoid(6).toLowerCase()}`;
	const daprWorkflowName = workflow.daprWorkflowName || `wf_${workflow.id}`;

	// Build the frozen revision snapshot
	const revision = {
		version: versionId,
		publishedAt: new Date().toISOString(),
		nodes: structuredClone(workflow.nodes),
		edges: structuredClone(workflow.edges),
		name: workflow.name,
		description: workflow.description
	};

	// Merge into existing spec or create new one
	const spec = (workflow.spec as Record<string, unknown>) || {};
	const metadata = (spec.metadata as Record<string, unknown>) || {};
	const publishedRuntime = (metadata.publishedRuntime as Record<string, unknown>) || {};
	const existingRevisions = (publishedRuntime.revisions as unknown[]) || [];

	const updatedPublishedRuntime = {
		...publishedRuntime,
		latestVersion: versionId,
		revisions: [...existingRevisions, revision]
	};

	const updatedSpec = {
		...spec,
		metadata: {
			...metadata,
			publishedRuntime: updatedPublishedRuntime
		}
	};

	const [updated] = await db
		.update(workflows)
		.set({
			spec: updatedSpec,
			daprWorkflowName: daprWorkflowName,
			updatedAt: new Date()
		})
		.where(eq(workflows.id, params.workflowId))
		.returning();

	return json(updated);
};

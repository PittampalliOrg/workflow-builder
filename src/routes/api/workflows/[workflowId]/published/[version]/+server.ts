import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

interface Revision {
	version: string;
	publishedAt: string;
	nodes: unknown[];
	edges: unknown[];
	name: string;
	description?: string;
}

export const GET: RequestHandler = async ({ params }) => {
	const workflow = await getApplicationAdapters().workflowData.getWorkflowByRef({
		workflowId: params.workflowId,
		lookup: 'id'
	});

	if (!workflow) {
		return error(404, 'Workflow not found');
	}

	const spec = (workflow.spec as Record<string, unknown>) || {};
	const metadata = (spec.metadata as Record<string, unknown>) || {};
	const publishedRuntime = (metadata.publishedRuntime as Record<string, unknown>) || {};
	const revisions = (publishedRuntime.revisions as Revision[]) || [];

	if (revisions.length === 0) {
		return error(404, 'No published versions found');
	}

	const requestedVersion = params.version;
	let revision: Revision | undefined;

	if (requestedVersion === 'latest') {
		revision = revisions[revisions.length - 1];
	} else {
		revision = revisions.find((r) => r.version === requestedVersion);
	}

	if (!revision) {
		return error(404, `Version "${requestedVersion}" not found`);
	}

	return json({
		workflowId: workflow.id,
		version: revision.version,
		publishedAt: revision.publishedAt,
		definition: {
			name: revision.name,
			description: revision.description,
			nodes: revision.nodes,
			edges: revision.edges
		},
		revisions: revisions.map((r) => ({
			version: r.version,
			publishedAt: r.publishedAt
		}))
	});
};

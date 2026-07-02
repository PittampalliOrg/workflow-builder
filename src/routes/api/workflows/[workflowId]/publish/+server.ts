import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { nanoid } from 'nanoid';
import { getRemovedSw10AgentCallsError } from '$lib/server/workflows/sw10-agent-validation';

export const POST: RequestHandler = async ({ params }) => {
	const workflowData = getApplicationAdapters().workflowData;
	const workflow = await workflowData.getWorkflowByRef({
		workflowId: params.workflowId,
		lookup: 'id',
	});

	if (!workflow) {
		return error(404, 'Workflow not found');
	}

	const versionId = `pub_${Date.now()}_${nanoid(6).toLowerCase()}`;
	const daprWorkflowName = workflow.daprWorkflowName || `wf_${workflow.id}`;
	const spec = (workflow.spec as Record<string, unknown>) || {};
	const removedAgentCallsError = getRemovedSw10AgentCallsError(spec);
	if (removedAgentCallsError) {
		return error(400, removedAgentCallsError);
	}

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

	const updated = await workflowData.updateWorkflowDefinition(params.workflowId, {
		spec: updatedSpec,
		daprWorkflowName,
	});

	return json(updated);
};

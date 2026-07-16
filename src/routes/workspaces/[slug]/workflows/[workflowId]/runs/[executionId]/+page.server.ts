import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.session?.userId) throw error(401, 'Authentication required');

	const scope = {
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null
	};
	const [workflow, execution] = await Promise.all([
		getApplicationAdapters().workflowData.getScopedWorkflowById({
			workflowId: params.workflowId,
			...scope
		}),
		getApplicationAdapters().workflowData.getScopedExecutionById({
			executionId: params.executionId,
			...scope
		})
	]);

	if (!workflow || !execution || execution.workflowId !== workflow.id) {
		throw error(404, 'Workflow run not found');
	}

	return {};
};

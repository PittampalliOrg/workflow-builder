import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import type {
	ServiceGraphExecutionOption,
	ServiceGraphWorkflowOption as ApplicationServiceGraphWorkflowOption
} from '$lib/server/application/ports';

export type ServiceGraphExecOption = ServiceGraphExecutionOption;
export type ServiceGraphWorkflowOption = ApplicationServiceGraphWorkflowOption;

/**
 * Cheap initial load for the service-graph page: the recent executions and
 * workflows that populate the selectors, plus a default execution to focus.
 * The graph itself is fetched client-side from /api/observability/service-graph
 * so toggles re-fetch without a full navigation.
 */
export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.session?.userId) throw error(401, 'Authentication required');

	const picker = await getApplicationAdapters().workflowData.listServiceGraphPickerOptions({
		userId: locals.session.userId,
		projectId: locals.session.projectId ?? null,
		workflowLimit: 200,
		executionLimit: 50
	});

	return {
		slug: params.slug,
		workflows: picker.workflows,
		executions: picker.executions,
		defaultExecutionId: picker.defaultExecutionId
	};
};

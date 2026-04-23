import type { PageServerLoad } from './$types';
import { getWorkflowOpsDetail } from '$lib/server/workflow-ops';

function suggestedRerunInstanceId(instanceId: string): string {
	const safeSource = instanceId
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(-54);
	const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
	return `${safeSource || 'workflow'}-rerun-${stamp}`;
}

export const load: PageServerLoad = async ({ params }) => {
	const detail = await getWorkflowOpsDetail(params.instanceId);
	return {
		detail,
		suggestedNewInstanceId: suggestedRerunInstanceId(params.instanceId)
	};
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getActionCatalogDetail } from '$lib/server/action-catalog';

export const GET: RequestHandler = async ({ params, locals }) => {
	const action = await getActionCatalogDetail(params.actionId, locals.session?.userId ?? null);
	if (!action) {
		return json({ error: 'Action not found' }, { status: 404 });
	}
	const raw =
		action.raw && typeof action.raw === 'object'
			? (action.raw as Record<string, unknown>)
			: null;
	return json({
		...action,
		definition: action.sw.definition,
		taskConfig: action.sw.taskConfig,
		functionRef: action.sw.functionName
			? {
					name: action.sw.functionName,
					version: action.version,
			  }
			: null,
		...(raw ?? {}),
	});
};

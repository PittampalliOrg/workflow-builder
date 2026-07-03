import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

export const GET: RequestHandler = async ({ params, url, locals }) => {
	const result = await getApplicationAdapters().workflowExport.getExport({
		workflowId: params.workflowId!,
		session: locals.session,
		language: url.searchParams.get('language'),
		inlineFunctions: url.searchParams.get('inlineFunctions'),
		format: url.searchParams.get('format'),
		download: url.searchParams.get('download'),
	});

	if (result.status === 'error') return error(result.httpStatus, result.body);
	if (result.status === 'json') return json(result.body);
	return new Response(result.source, { status: 200, headers: result.headers });
};

export const POST: RequestHandler = async ({ params, url, request, locals }) => {
	const body = await request.json().catch(() => ({}));
	const result = await getApplicationAdapters().workflowExport.saveExport({
		workflowId: params.workflowId!,
		session: locals.session,
		language: url.searchParams.get('language'),
		inlineFunctions: url.searchParams.get('inlineFunctions'),
		body,
	});
	if (result.status === 'error') return error(result.httpStatus, result.body);
	return json(result.body);
};

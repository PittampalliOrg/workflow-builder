import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { daprFetch, getFnActivepiecesUrl } from '$lib/server/dapr-client';
import { getCodeFunctionBySlug, toCodeFunctionDefinitionFromDetail } from '$lib/server/code-functions';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (locals.session?.userId) {
		const detail = await getCodeFunctionBySlug(
			params.name,
			params.version,
			locals.session.userId,
		);
		if (detail) {
			return json(toCodeFunctionDefinitionFromDetail(detail));
		}
	}

	try {
		const res = await daprFetch(
			`${getFnActivepiecesUrl()}/catalog/functions/${params.name}/${params.version}/function.yaml`,
			{ maxRetries: 1 }
		);
		if (!res.ok) {
			return json({ error: 'Function not found' }, { status: 404 });
		}
		return json(await res.json());
	} catch (err) {
		return json({ error: String(err) }, { status: 502 });
	}
};

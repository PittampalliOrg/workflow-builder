import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCodeFunctionBySlug, toCodeFunctionDefinitionFromDetail } from '$lib/server/code-functions';
import { getPieceCatalogDefinition } from '$lib/server/action-catalog/piece-metadata-source';

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
		const definition = await getPieceCatalogDefinition(params.name);
		if (!definition) {
			return json({ error: 'Function not found' }, { status: 404 });
		}
		return json(definition);
	} catch (err) {
		return json({ error: String(err) }, { status: 502 });
	}
};

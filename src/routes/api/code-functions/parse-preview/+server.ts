import { json, error } from '@sveltejs/kit';
import { getApplicationAdapters } from '$lib/server/application';
import { ApplicationCodeFunctionParsePreviewError } from '$lib/server/application/code-function-parse-preview';

export const POST = async ({ request }: { request: Request }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	try {
		return json(await getApplicationAdapters().codeFunctionParsePreview.parse({ body }));
	} catch (err) {
		if (err instanceof ApplicationCodeFunctionParsePreviewError) {
			if (err.status === 502) {
				return json({ error: err.message }, { status: err.status });
			}
			throw error(err.status, err.message);
		}
		throw err;
	}
};

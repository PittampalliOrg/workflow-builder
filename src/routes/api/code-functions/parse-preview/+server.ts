import { json, error } from '@sveltejs/kit';
import { parseCodePreview, type CodeParserRequest } from '$lib/server/code-parser';

function isLanguage(value: unknown): value is 'typescript' | 'python' {
	return value === 'typescript' || value === 'python';
}

export const POST = async ({ request }: { request: Request }) => {
	let body: Partial<CodeParserRequest> & Record<string, unknown>;
	try {
		body = (await request.json()) as Partial<CodeParserRequest> & Record<string, unknown>;
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	if (!isLanguage(body.language)) {
		throw error(400, 'language must be typescript or python');
	}

	if (typeof body.source !== 'string' || body.source.trim().length === 0) {
		throw error(400, 'source is required');
	}

	try {
		const supportingFiles =
			body.supporting_files && typeof body.supporting_files === 'object'
				? (body.supporting_files as Record<string, string>)
				: body.supportingFiles && typeof body.supportingFiles === 'object'
					? (body.supportingFiles as Record<string, string>)
					: undefined;
		const model = await parseCodePreview({
			language: body.language,
			source: body.source,
			entrypoint: typeof body.entrypoint === 'string' && body.entrypoint.trim()
				? body.entrypoint.trim()
				: undefined,
			path: typeof body.path === 'string' && body.path.trim() ? body.path.trim() : undefined,
			supportingFiles,
		});
		return json({ model });
	} catch (err) {
		return json(
			{
				error: err instanceof Error ? err.message : String(err),
			},
			{ status: 502 },
		);
	}
};

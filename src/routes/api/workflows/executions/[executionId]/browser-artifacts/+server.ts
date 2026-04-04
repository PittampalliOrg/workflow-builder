import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listBrowserArtifactsByExecutionId } from '$lib/server/browser-artifacts';

export const GET: RequestHandler = async ({ params }) => {
	try {
		const artifacts = await listBrowserArtifactsByExecutionId(params.executionId);
		return json({ artifacts });
	} catch (err) {
		throw error(500, err instanceof Error ? err.message : 'Failed to load browser artifacts');
	}
};

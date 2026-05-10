import { error, json } from '@sveltejs/kit';
import { fetchKueueVizYaml } from '$lib/server/kueueviz';
import type { RequestHandler } from './$types';

/**
 * Server-side passthrough for the upstream YAML endpoint:
 *   GET /api/kueueviz/yaml?type=<resource>&name=<name>&namespace=<ns?>
 *
 * Translates to the upstream
 *   GET /api/:resourceType/:name?output=yaml&namespace=<ns?>
 *
 * The upstream handler accepts a fixed allowlist of resource types
 * (workload, clusterqueue, localqueue, resourceflavor, cohort, event,
 * node, pod). We only forward — no schema validation here beyond what
 * the upstream enforces.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.session?.userId) throw error(401, 'Authentication required');
	const resourceType = url.searchParams.get('type');
	const name = url.searchParams.get('name');
	const namespace = url.searchParams.get('namespace') ?? undefined;
	if (!resourceType) throw error(400, 'missing required query param "type"');
	if (!name) throw error(400, 'missing required query param "name"');

	const result = await fetchKueueVizYaml({ resourceType, name, namespace });
	if (!result.ok) {
		throw error(result.status === 400 ? 400 : 502, result.message);
	}
	return json({ content: result.content, format: result.format });
};

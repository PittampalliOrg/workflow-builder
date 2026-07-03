import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';

// The trigger-kind catalog (label/icon/configSchema/backing/requiresActivation),
// so the UI can render the category selector + per-kind config fields. The
// registry itself is server-only; this exposes it read-only to the client.
export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.session?.userId) return json({ kinds: [] }, { status: 401 });
	return json(getApplicationAdapters().workflowTriggerKindCatalog.listKinds());
};

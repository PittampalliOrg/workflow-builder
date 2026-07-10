import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { PreviewEnvironmentDesiredStateError } from '$lib/server/application/ports';
import { requirePreviewControlBroker } from '$lib/server/internal-auth';

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const GET: RequestHandler = async ({ request, params }) => {
	if (
		(env.PREVIEW_CONTROL_BROKER_MODE || process.env.PREVIEW_CONTROL_BROKER_MODE || '')
			.trim()
			.toLowerCase() !== 'true'
	) {
		return json({ ok: false, error: 'not found' }, { status: 404 });
	}
	requirePreviewControlBroker(request);
	if (!NAME.test(params.name)) {
		return json({ ok: false, error: 'invalid preview name' }, { status: 400 });
	}
	try {
		const cleanup = await getApplicationAdapters().previewEnvironmentLifecycleBroker.cleanup(
			params.name
		);
		return json({ ok: true, cleanup });
	} catch (cause) {
		if (cause instanceof PreviewEnvironmentDesiredStateError) {
			return json({ ok: false, error: cause.message }, { status: 503 });
		}
		throw cause;
	}
};

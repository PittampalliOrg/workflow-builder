import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import {
	PreviewEnvironmentDesiredStateError,
	PreviewEnvironmentDesiredStateOwnershipError
} from '$lib/server/application/ports';
import { requirePreviewControlBroker } from '$lib/server/internal-auth';
import type { VclusterPreviewTeardownTicket } from '$lib/types/dev-previews';
import {
	BoundedJsonBodyError,
	PREVIEW_CONTROL_JSON_MAX_BYTES,
	readBoundedJsonObject
} from '../../../../../_shared/bounded-json-body';

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SHA = /^[0-9a-f]{40}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;

function parseTicket(value: unknown, expectedName: string): VclusterPreviewTeardownTicket | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const ticket = value as Record<string, unknown>;
	if (
		Object.keys(ticket).length !== 5 ||
		!Object.keys(ticket).every((key) =>
			['name', 'environmentUid', 'requestId', 'sourceRevision', 'signature'].includes(key)
		) ||
		ticket.name !== expectedName ||
		typeof ticket.environmentUid !== 'string' ||
		ticket.environmentUid.length < 1 ||
		ticket.environmentUid.length > 128 ||
		typeof ticket.requestId !== 'string' ||
		ticket.requestId.length < 1 ||
		ticket.requestId.length > 256 ||
		typeof ticket.sourceRevision !== 'string' ||
		!SHA.test(ticket.sourceRevision) ||
		typeof ticket.signature !== 'string' ||
		!SIGNATURE.test(ticket.signature)
	) {
		return null;
	}
	return ticket as VclusterPreviewTeardownTicket;
}

export const POST: RequestHandler = async ({ request, params }) => {
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
	let body: Record<string, unknown>;
	try {
		body = await readBoundedJsonObject(request, PREVIEW_CONTROL_JSON_MAX_BYTES);
	} catch (cause) {
		if (cause instanceof BoundedJsonBodyError) {
			return json({ ok: false, error: cause.message }, { status: cause.statusCode });
		}
		throw cause;
	}
	if (Object.keys(body).length !== 1) {
		return json({ ok: false, error: 'invalid teardown status query' }, { status: 400 });
	}
	const ticket = parseTicket(body.ticket, params.name);
	if (!ticket) {
		return json({ ok: false, error: 'invalid teardown ticket' }, { status: 400 });
	}
	try {
		const result = await getApplicationAdapters().previewEnvironmentLifecycleBroker.status(ticket);
		return json(
			{ ok: true, ...result },
			{ status: result.cleanup.complete ? 200 : 202 }
		);
	} catch (cause) {
		if (cause instanceof PreviewEnvironmentDesiredStateOwnershipError) {
			return json({ ok: false, error: cause.message }, { status: 409 });
		}
		if (cause instanceof PreviewEnvironmentDesiredStateError) {
			return json({ ok: false, error: cause.message }, { status: 503 });
		}
		throw cause;
	}
};

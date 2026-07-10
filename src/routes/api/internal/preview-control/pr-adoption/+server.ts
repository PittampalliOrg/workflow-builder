import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { requirePreviewControlCapability } from '$lib/server/internal-auth';
import {
	BoundedJsonBodyError,
	PREVIEW_CONTROL_JSON_MAX_BYTES,
	readBoundedJsonObject
} from '../../_shared/bounded-json-body';

const ALLOWED = new Set([
	'name',
	'requestId',
	'platformRevision',
	'sourceRevision',
	'catalogDigest',
	'services',
	'origin',
	'waitReadySeconds'
]);

export const POST: RequestHandler = async ({ request }) => {
	const app = getApplicationAdapters();
	const identity = app.previewLocalControlIdentity.current();
	requirePreviewControlCapability(request, identity);
	let body: Record<string, unknown>;
	try {
		body = await readBoundedJsonObject(request, PREVIEW_CONTROL_JSON_MAX_BYTES);
	} catch (cause) {
		if (cause instanceof BoundedJsonBodyError) {
			return json({ ok: false, error: cause.message }, { status: cause.statusCode });
		}
		throw cause;
	}
	const value = body;
	const unexpected = Object.keys(value).filter((key) => !ALLOWED.has(key));
	if (unexpected.length) {
		return json(
			{
				ok: false,
				error: `unsupported PR adoption fields: ${unexpected.sort().join(', ')}`
			},
			{ status: 400 }
		);
	}
	const bodyIdentity = {
		previewName: value.name,
		environmentRequestId: value.requestId,
		environmentPlatformRevision: value.platformRevision,
		environmentSourceRevision: value.sourceRevision,
		catalogDigest: value.catalogDigest
	};
	if (
		bodyIdentity.previewName !== identity.previewName ||
		bodyIdentity.environmentRequestId !== identity.environmentRequestId ||
		bodyIdentity.environmentPlatformRevision !== identity.environmentPlatformRevision ||
		bodyIdentity.environmentSourceRevision !== identity.environmentSourceRevision ||
		bodyIdentity.catalogDigest !== identity.catalogDigest
	) {
		return json(
			{ ok: false, error: 'PR adoption authority does not match this preview' },
			{ status: 409 }
		);
	}
	const services = Array.isArray(value.services) ? value.services : [];
	let stagedServices: unknown;
	try {
		stagedServices = JSON.parse(env.PREVIEW_ENVIRONMENT_SERVICES_JSON ?? '');
	} catch {
		return json({ ok: false, error: 'preview service authority is unavailable' }, { status: 503 });
	}
	if (
		!Array.isArray(stagedServices) ||
		!services.every((service) => typeof service === 'string') ||
		JSON.stringify([...services].sort()) !== JSON.stringify([...stagedServices].sort())
	) {
		return json(
			{
				ok: false,
				error: 'PR adoption service set does not match this preview'
			},
			{ status: 409 }
		);
	}
	if (
		typeof value.origin !== 'string' ||
		typeof value.waitReadySeconds !== 'number' ||
		!Number.isInteger(value.waitReadySeconds) ||
		value.waitReadySeconds < 1 ||
		value.waitReadySeconds > 600
	) {
		return json({ ok: false, error: 'PR adoption options are invalid' }, { status: 400 });
	}
	try {
		const result = await app.previewPrAdoption.adopt({
			...identity,
			services: services as string[],
			origin: value.origin,
			waitReadySeconds: value.waitReadySeconds
		});
		return json(result, { status: result.ok ? 200 : 207 });
	} catch (cause) {
		return json(
			{
				ok: false,
				error: cause instanceof Error ? cause.message : String(cause)
			},
			{ status: 409 }
		);
	}
};

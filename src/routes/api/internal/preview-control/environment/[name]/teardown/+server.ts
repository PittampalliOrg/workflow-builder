import { env } from '$env/dynamic/private';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import {
	PreviewEnvironmentDesiredStateError,
	PreviewEnvironmentDesiredStateOwnershipError,
	type PreviewArchiveQuarantineGuard
} from '$lib/server/application/ports';
import { requirePreviewControlBroker } from '$lib/server/internal-auth';
import {
	BoundedJsonBodyError,
	PREVIEW_CONTROL_JSON_MAX_BYTES,
	readBoundedJsonObject
} from '../../../../_shared/bounded-json-body';

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SHA = /^[0-9a-f]{40}$/;

function archiveQuarantine(
	value: unknown
): PreviewArchiveQuarantineGuard | null | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		!Object.keys(record).every((key) =>
			['forcedAt', 'graceExpiredAt', 'reason', 'summaryFileId'].includes(key)
		) ||
		Object.keys(record).length < 3 ||
		typeof record.forcedAt !== 'string' ||
		Number.isNaN(Date.parse(record.forcedAt)) ||
		new Date(record.forcedAt).toISOString() !== record.forcedAt ||
		typeof record.graceExpiredAt !== 'string' ||
		Number.isNaN(Date.parse(record.graceExpiredAt)) ||
		new Date(record.graceExpiredAt).toISOString() !== record.graceExpiredAt ||
		Date.parse(record.forcedAt) < Date.parse(record.graceExpiredAt) ||
		typeof record.reason !== 'string' ||
		record.reason.length < 1 ||
		record.reason.length > 240 ||
		(record.summaryFileId !== undefined &&
			(typeof record.summaryFileId !== 'string' ||
				record.summaryFileId.length < 1 ||
				record.summaryFileId.length > 256))
	) {
		return null;
	}
	return {
		forcedAt: record.forcedAt,
		graceExpiredAt: record.graceExpiredAt,
		reason: record.reason,
		...(typeof record.summaryFileId === 'string' ? { summaryFileId: record.summaryFileId } : {})
	};
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
		return json({ ok: false, error: 'invalid teardown command' }, { status: 400 });
	}
	const rawGuard = body.guard;
	if (!rawGuard || typeof rawGuard !== 'object' || Array.isArray(rawGuard)) {
		return json({ ok: false, error: 'teardown guard is required' }, { status: 400 });
	}
	const value = rawGuard as Record<string, unknown>;
	const quarantine = archiveQuarantine(value.archiveQuarantine);
	let guard:
		| Readonly<{
				mode: 'owned';
				requestId: string;
				sourceRevision: string;
				archiveConfirmed?: true;
				archiveQuarantine?: PreviewArchiveQuarantineGuard;
		  }>
		| Readonly<{ mode: 'superseded'; protectedRequestId: string }>;
	if (
		value.mode === 'owned' &&
		Object.keys(value).every((key) =>
			['mode', 'requestId', 'sourceRevision', 'archiveConfirmed', 'archiveQuarantine'].includes(key)
		) &&
		typeof value.requestId === 'string' &&
		value.requestId.length > 0 &&
		value.requestId.length <= 256 &&
		typeof value.sourceRevision === 'string' &&
		SHA.test(value.sourceRevision) &&
		(value.archiveConfirmed === undefined || value.archiveConfirmed === true) &&
		quarantine !== null &&
		(quarantine === undefined || value.archiveConfirmed === true)
	) {
		guard = {
			mode: 'owned',
			requestId: value.requestId,
			sourceRevision: value.sourceRevision,
			...(value.archiveConfirmed === true ? { archiveConfirmed: true } : {}),
			...(quarantine ? { archiveQuarantine: quarantine } : {})
		};
	} else if (
		value.mode === 'superseded' &&
		Object.keys(value).length === 2 &&
		typeof value.protectedRequestId === 'string' &&
		value.protectedRequestId.length > 0 &&
		value.protectedRequestId.length <= 256
	) {
		guard = {
			mode: 'superseded',
			protectedRequestId: value.protectedRequestId
		};
	} else {
		return json({ ok: false, error: 'invalid teardown guard' }, { status: 400 });
	}
	try {
		const result = await getApplicationAdapters().previewEnvironmentLifecycleBroker.teardown({
			name: params.name,
			guard
		});
		return json({ ok: true, ...result });
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

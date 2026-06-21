import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireInternal } from '$lib/server/internal-auth';
import { appendEvent } from '$lib/server/sessions/events';

/**
 * POST /api/internal/sessions/provisioning/ingest
 *
 * The capacity-observer pushes per-session sandbox provisioning phase
 * transitions here (admitted → scheduled → pulling → initialized → running /
 * failed). We persist each transition as a `session.provisioning_<phase>`
 * row in `session_events` so it survives the pod and streams live to the Run
 * Console via the existing session-events LISTEN/NOTIFY → SSE pipeline.
 *
 * Idempotent: `appendEvent` dedupes on `sourceEventId` (`prov:<sid>:<phase>`),
 * so observer restarts re-sending the same phase are no-ops. Best-effort by
 * contract — the observer treats failures as non-fatal to /snapshot.
 *
 * Body: { sessionId, phase, at?, durationMs?, podName?, namespace?, reason? }
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return error(400, 'Expected JSON body');
	}

	if (!body || typeof body !== 'object') return error(400, 'Expected JSON object');
	const b = body as Record<string, unknown>;

	const sessionId = typeof b.sessionId === 'string' ? b.sessionId.trim() : '';
	const phase = typeof b.phase === 'string' ? b.phase.trim() : '';
	if (!sessionId) return error(400, 'sessionId is required');
	if (!phase) return error(400, 'phase is required');

	const at = typeof b.at === 'string' ? b.at : null;
	const durationMs =
		typeof b.durationMs === 'number' && Number.isFinite(b.durationMs) ? b.durationMs : null;
	const podName = typeof b.podName === 'string' ? b.podName : null;
	const namespace = typeof b.namespace === 'string' ? b.namespace : null;
	const reason = typeof b.reason === 'string' ? b.reason : null;

	const event = await appendEvent(sessionId, {
		type: `session.provisioning_${phase}`,
		data: { phase, at, durationMs, podName, namespace, reason },
		sourceEventId: `prov:${sessionId}:${phase}`,
		processedAt: at ? new Date(at) : null
	});

	return json({ ok: true, sequence: event.sequence, type: event.type });
};

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getApplicationAdapters } from '$lib/server/application';
import { requireInternal } from '$lib/server/internal-auth';

function isDatabaseNotConfigured(err: unknown): boolean {
	return err instanceof Error && err.message.includes('Database not configured');
}

/**
 * POST /api/internal/sessions/provisioning/ingest
 *
 * The capacity-observer pushes per-session sandbox provisioning phase
 * transitions here (admitted → scheduled → pulling → initialized → running /
 * failed). We persist each transition as a `session.provisioning_<phase>`
 * row in `session_events` so it survives the pod and streams live to the Run
 * Console via the existing session-events LISTEN/NOTIFY → SSE pipeline.
 *
 * The observer derives the session id from the pod's
 * `workflow-builder.cnoe.io/session-id` label, which is a k8s-safe value that
 * may not equal `sessions.id`. We resolve it tolerantly (by `id`, else
 * `dapr_instance_id`) and — crucially — **return 200 no-op when no session
 * matches** (e.g. benchmark-coordinator pods that have no `sessions` row).
 * Returning an error here would FK-500 and make the observer retry forever.
 *
 * Idempotent: `appendEvent` dedupes on `sourceEventId` (`prov:<sid>:<phase>`),
 * so observer restarts re-sending the same phase are no-ops.
 *
 * Body: { sessionId, phase, at?, durationMs?, podName?, namespace?, reason? }
 */
export const POST: RequestHandler = async ({ request }) => {
	requireInternal(request);

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return json({ ok: false, skipped: 'bad_json' });
	}

	if (!body || typeof body !== 'object') return json({ ok: false, skipped: 'bad_body' });
	const b = body as Record<string, unknown>;

	// runtimeAppId is the per-session sandbox app-id (= sessions.runtime_app_id),
	// the only stable per-session key the observer can read off the pod. sessionId
	// is the (parent) label — used only as a last-resort fallback.
	const runtimeAppId = typeof b.runtimeAppId === 'string' ? b.runtimeAppId.trim() : '';
	const rawSessionId = typeof b.sessionId === 'string' ? b.sessionId.trim() : '';
	const phase = typeof b.phase === 'string' ? b.phase.trim() : '';
	if ((!runtimeAppId && !rawSessionId) || !phase)
		return json({ ok: false, skipped: 'missing_fields' });

	// Resolve to a real session row by runtime_app_id (primary), else by id /
	// dapr_instance_id. Skip (200) when none matches (e.g. benchmark-coordinator
	// pods with no sessions row) so the observer marks it done instead of looping
	// on an FK failure.
	let sessionId: string | null;
	let workflowData: ReturnType<typeof getApplicationAdapters>['workflowData'];
	try {
		({ workflowData } = getApplicationAdapters());
		sessionId = await workflowData.resolveSessionIdForProvisioningEvent({
			runtimeAppId,
			sessionId: rawSessionId
		});
	} catch (err) {
		if (isDatabaseNotConfigured(err)) return json({ ok: false, skipped: 'no_db' });
		throw err;
	}
	if (!sessionId) return json({ ok: false, skipped: 'no_session' });

	const at = typeof b.at === 'string' ? b.at : null;
	const durationMs =
		typeof b.durationMs === 'number' && Number.isFinite(b.durationMs) ? b.durationMs : null;
	const podName = typeof b.podName === 'string' ? b.podName : null;
	const namespace = typeof b.namespace === 'string' ? b.namespace : null;
	const reason = typeof b.reason === 'string' ? b.reason : null;

	const event = await workflowData.appendSessionEvent(sessionId, {
		type: `session.provisioning_${phase}`,
		data: { phase, at, durationMs, podName, namespace, reason },
		sourceEventId: `prov:${sessionId}:${phase}`,
		processedAt: at ? new Date(at) : null
	});

	return json({ ok: true, sequence: event.sequence, type: event.type });
};

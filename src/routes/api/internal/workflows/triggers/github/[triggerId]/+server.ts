import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { workflowTriggers } from '$lib/server/db/schema';
import { daprFetch, getDaprSidecarUrl } from '$lib/server/dapr-client';
import { getGithubTriggerSecret } from '$lib/server/lifecycle/github-webhook';

/**
 * Public GitHub webhook receiver — GitHub delivers here over Tailscale Funnel.
 *
 * Auth is the per-trigger HMAC secret (`X-Hub-Signature-256`), NOT the internal
 * token (GitHub can't send our internal header). We validate the signature over
 * the RAW body, filter by `X-GitHub-Event`, then publish the standard
 * `workflow.triggers` envelope so the spine's idempotency (deterministic exec id
 * from `X-GitHub-Delivery`) + concurrency gate apply uniformly.
 *
 * Status codes (visible in GitHub's "Recent Deliveries"):
 *   202 accepted (published) · 200 ignored/ping · 401 bad signature ·
 *   404 unknown trigger · 409 inactive · 503 db down.
 */

function timingSafeEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return crypto.timingSafeEqual(ba, bb);
}

function asRecord(v: unknown): Record<string, unknown> {
	return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const POST: RequestHandler = async ({ request, params }) => {
	const triggerId = params.triggerId;
	if (!db) return json({ error: 'db unavailable' }, { status: 503 });
	if (!triggerId) return json({ error: 'not found' }, { status: 404 });

	// Raw body is required for HMAC — read once.
	const raw = await request.text();

	const [row] = await db
		.select()
		.from(workflowTriggers)
		.where(eq(workflowTriggers.id, triggerId))
		.limit(1);
	if (!row || row.kind !== 'github') return json({ error: 'not found' }, { status: 404 });
	if (row.status !== 'active') return json({ error: 'inactive' }, { status: 409 });

	const config = asRecord(row.config);
	const secret = getGithubTriggerSecret(config);
	if (!secret) {
		console.warn('[triggers/github] no HMAC secret on trigger', { triggerId });
		return json({ error: 'misconfigured' }, { status: 409 });
	}

	// HMAC validation (sha256). GitHub sends `sha256=<hex>`.
	const sig = request.headers.get('x-hub-signature-256') ?? '';
	const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
	if (!sig || !timingSafeEqual(sig, expected)) {
		return json({ error: 'bad signature' }, { status: 401 });
	}

	const event = request.headers.get('x-github-event') ?? '';
	const delivery = request.headers.get('x-github-delivery') ?? '';

	// GitHub pings the hook on creation — acknowledge so it shows green.
	if (event === 'ping') return json({ ok: true, pong: true });

	const wantEvents = (typeof config.events === 'string' ? config.events : 'push')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (wantEvents.length && !wantEvents.includes(event)) {
		// Subscribed at the GitHub level but not this event type → ACK + ignore.
		return json({ ok: true, ignored: event });
	}

	let payload: Record<string, unknown> = {};
	try {
		payload = asRecord(JSON.parse(raw));
	} catch {
		payload = {};
	}

	// Compact, jq-friendly fields at the top (so `${ .trigger.prNumber }` works),
	// plus the full event under `.event` for power users.
	const repository = asRecord(payload.repository);
	const sender = asRecord(payload.sender);
	const triggerData: Record<string, unknown> = {
		...asRecord(row.triggerData),
		githubEvent: event,
		action: typeof payload.action === 'string' ? payload.action : undefined,
		repository: typeof repository.full_name === 'string' ? repository.full_name : undefined,
		sender: typeof sender.login === 'string' ? sender.login : undefined,
		event: payload
	};
	if (event === 'pull_request') {
		const pr = asRecord(payload.pull_request);
		const head = asRecord(pr.head);
		const base = asRecord(pr.base);
		triggerData.prNumber = payload.number ?? pr.number;
		triggerData.prTitle = pr.title;
		triggerData.prUrl = pr.html_url;
		triggerData.prState = pr.state;
		triggerData.prHeadRef = head.ref;
		triggerData.prBaseRef = base.ref;
	}

	// `X-GitHub-Delivery` is unique per delivery (and stable across GitHub's manual
	// "Redeliver") → exactly the dedup key the idempotent spine wants.
	const dedupKey = delivery || `${triggerId}:${event}:${crypto.randomUUID()}`;
	const envelope = {
		workflowId: row.workflowId,
		triggerId: row.id,
		dedupKey,
		triggerData
	};

	try {
		const res = await daprFetch(
			`${getDaprSidecarUrl()}/v1.0/publish/workflow-triggers-pubsub/workflow.triggers`,
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(envelope)
			}
		);
		if (!res.ok) {
			const text = await res.text().catch(() => '');
			return json({ error: `publish failed (${res.status})`, detail: text }, { status: 502 });
		}
	} catch (err) {
		return json(
			{ error: err instanceof Error ? err.message : 'publish failed' },
			{ status: 502 }
		);
	}

	// Best-effort last-fired stamp (don't fail the delivery on a write error).
	try {
		await db
			.update(workflowTriggers)
			.set({ lastFiredAt: new Date() })
			.where(eq(workflowTriggers.id, triggerId));
	} catch {
		/* ignore */
	}

	return json({ accepted: true, event, dedupKey }, { status: 202 });
};

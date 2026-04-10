import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sandboxEventBus } from '$lib/server/sandbox-event-bus';
import { daprEventStream } from '$lib/server/dapr-event-stream';

/**
 * Dapr pub/sub event handler for sandbox events.
 *
 * Dapr delivers events from the `workflow.stream` topic here via the
 * declarative Subscription CRD. Events are routed through the sandbox
 * event bus to SSE subscribers.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();

	// Also push to the dapr event stream for the Dapr System dashboard
	const streamEventType = body.type ?? body.data?.type ?? 'unknown';
	daprEventStream.push('workflow.stream', streamEventType, body.source ?? '', body.data ?? body);

	// Dapr CloudEvents envelope: body.type is the event type, body.data has the payload
	const eventType = body.type ?? body.data?.type ?? '';
	const data = body.data ?? body;

	switch (eventType) {
		case 'sandbox.list_snapshot': {
			const sandboxes = data.sandboxes ?? [];
			sandboxEventBus.handleSnapshot(sandboxes);
			break;
		}

		case 'sandbox.phase_changed': {
			const sandboxName = data.sandboxName ?? '';
			const phase = data.phase ?? 'UNKNOWN';
			const sandbox = data.sandbox ?? null;
			if (sandboxName) {
				sandboxEventBus.handlePhaseChanged(sandboxName, phase, sandbox);
			}
			break;
		}

		case 'sandbox.create.completed': {
			const sandboxName = data.sandboxName ?? '';
			if (sandboxName) {
				sandboxEventBus.handleCreateCompleted(sandboxName);
			}
			break;
		}

		case 'sandbox.delete.completed': {
			const sandboxName = data.sandboxName ?? '';
			if (sandboxName) {
				sandboxEventBus.handleDeleteCompleted(sandboxName);
			}
			break;
		}

		case 'sandbox.delete.started':
		case 'sandbox.create.failed':
		case 'sandbox.delete.failed':
			// Acknowledge but no action needed for these
			break;

		default:
			// Not a sandbox event — ignore (other workflow.stream events pass through)
			break;
	}

	// Return 200 to acknowledge the message (Dapr will not redeliver)
	return json({ status: 'SUCCESS' });
};

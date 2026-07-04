import type { JetStreamClient, JetStreamManager } from "nats";
import {
	getJetStream,
	getJetStreamManager,
	previewStreamName,
	previewWorkflowEventsSubject,
} from "$lib/server/nats-client";
import type {
	CrossPreviewRunEvent,
	CrossPreviewRunFeedPort,
	CrossPreviewTarget,
} from "$lib/server/application/ports";

function asString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed ? trimmed : null;
}

function statusFromEventType(eventType: string): CrossPreviewRunEvent["status"] {
	if (eventType === "workflow.completed") return "completed";
	if (eventType === "workflow.failed") return "failed";
	if (eventType.startsWith("workflow.")) return "running";
	return "unknown";
}

/**
 * Unwrap a NATS message body to the orchestrator's workflow CloudEvent. The
 * message may be double-wrapped (Dapr CloudEvent envelope around the
 * orchestrator payload) and `data` may arrive as a JSON string — walk down
 * `.data` up to a few levels looking for `{ type: "workflow.*", data: {...} }`.
 */
function findWorkflowEvent(
	raw: unknown,
): { type: string; data: Record<string, unknown> } | null {
	let node: unknown = raw;
	for (let depth = 0; depth < 4 && node && typeof node === "object"; depth++) {
		const obj = node as Record<string, unknown>;
		const type = typeof obj.type === "string" ? obj.type : null;
		if (type?.startsWith("workflow.") && obj.data && typeof obj.data === "object") {
			return { type, data: obj.data as Record<string, unknown> };
		}
		if (typeof obj.data === "string") {
			try {
				node = JSON.parse(obj.data);
				continue;
			} catch {
				return null;
			}
		}
		node = obj.data;
	}
	return null;
}

/** Pure decode: a raw NATS message body + its preview -> a normalized event. */
export function decodeCrossPreviewRunEvent(
	raw: unknown,
	preview: CrossPreviewTarget,
): CrossPreviewRunEvent | null {
	const found = findWorkflowEvent(raw);
	if (!found) return null;
	const data = found.data;
	const envelopeTime =
		raw && typeof raw === "object" ? asString((raw as Record<string, unknown>).time) : null;
	return {
		previewName: preview.name,
		previewUrl: preview.url,
		eventType: found.type,
		executionId: asString(data.executionId),
		workflowId: asString(data.workflowId),
		workflowName: asString(data.workflowName),
		phase: asString(data.phase),
		progress: typeof data.progress === "number" ? data.progress : null,
		status: statusFromEventType(found.type),
		message: asString(data.message) ?? asString(data.error),
		at: asString(data.timestamp) ?? envelopeTime ?? new Date().toISOString(),
	};
}

export type NatsCrossPreviewRunFeedDeps = {
	jetStream?: () => Promise<JetStreamClient>;
	jetStreamManager?: () => Promise<JetStreamManager>;
};

/**
 * Reads each preview's `ORCHESTRATOR-<name>` stream off the shared host NATS via
 * a read-only ordered (ephemeral) consumer starting at `new` — no acks, no
 * durable state, auto-recreated on gaps. Previews without a stream are skipped.
 */
export class NatsCrossPreviewRunFeed implements CrossPreviewRunFeedPort {
	constructor(private readonly deps: NatsCrossPreviewRunFeedDeps = {}) {}

	async subscribe(input: {
		previews: CrossPreviewTarget[];
		onEvent: (event: CrossPreviewRunEvent) => void;
		onError?: (previewName: string, error: unknown) => void;
	}): Promise<() => Promise<void>> {
		const js = await (this.deps.jetStream ?? getJetStream)();
		const jsm = await (this.deps.jetStreamManager ?? getJetStreamManager)();
		const stoppers: Array<() => void> = [];

		await Promise.all(
			input.previews.map(async (preview) => {
				const stream = previewStreamName(preview.name);
				try {
					// Absent stream (preview has no orchestrator events yet) is not an error.
					await jsm.streams.info(stream);
				} catch {
					return;
				}
				try {
					const consumer = await js.consumers.get(stream, {
						filterSubjects: previewWorkflowEventsSubject(preview.name),
						deliver_policy: "new",
					} as never);
					const messages = await consumer.consume();
					stoppers.push(() => messages.stop());
					// Background drain — never awaited so subscribe() returns promptly.
					(async () => {
						for await (const msg of messages) {
							try {
								const decoded = decodeCrossPreviewRunEvent(msg.json(), preview);
								if (decoded) input.onEvent(decoded);
							} catch (err) {
								input.onError?.(preview.name, err);
							}
						}
					})().catch((err) => input.onError?.(preview.name, err));
				} catch (err) {
					input.onError?.(preview.name, err);
				}
			}),
		);

		let stopped = false;
		return async () => {
			if (stopped) return;
			stopped = true;
			for (const stop of stoppers) {
				try {
					stop();
				} catch {
					/* best effort */
				}
			}
		};
	}
}

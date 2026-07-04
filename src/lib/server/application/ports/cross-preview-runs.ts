/**
 * Cross-preview run feed (E1).
 *
 * A read-only, live aggregation of workflow run events across all active Tier-2
 * preview vclusters, consumed off the shared host NATS (each preview publishes
 * into its own JetStream stream `ORCHESTRATOR-<name>`). This is the outbound
 * port; the NATS adapter implements it and the Dev-hub feed service composes it.
 */

/** One preview to tail, as surfaced by the SEA vcluster-previews client. */
export type CrossPreviewTarget = {
	name: string;
	url: string | null;
};

/** A normalized workflow event observed in some preview's run stream. */
export type CrossPreviewRunEvent = {
	previewName: string;
	previewUrl: string | null;
	/** CloudEvent type, e.g. "workflow.started" / "workflow.phase.changed". */
	eventType: string;
	executionId: string | null;
	workflowId: string | null;
	workflowName: string | null;
	phase: string | null;
	progress: number | null;
	/** Coarse status derived from the event type. */
	status: "running" | "completed" | "failed" | "unknown";
	message: string | null;
	/** Event time (ISO 8601) — the producer timestamp when present, else receipt. */
	at: string;
};

export interface CrossPreviewRunFeedPort {
	/**
	 * Open read-only ephemeral consumers for each preview's run stream and invoke
	 * `onEvent` for every decoded workflow event. Previews without a stream yet
	 * are skipped (not an error). Returns an async unsubscribe that tears down all
	 * consumers; safe to call more than once.
	 */
	subscribe(input: {
		previews: CrossPreviewTarget[];
		onEvent: (event: CrossPreviewRunEvent) => void;
		onError?: (previewName: string, error: unknown) => void;
	}): Promise<() => Promise<void>>;
}

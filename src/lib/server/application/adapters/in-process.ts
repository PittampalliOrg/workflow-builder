import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
	LITE_WORKFLOW_INSTANCE_PREFIX,
	LITE_WORKFLOW_NOT_EXECUTED_MESSAGE,
} from "$lib/server/application/lite-profile";
import type {
	EventBus,
	WorkflowScheduler,
	WorkflowStartRequest,
} from "$lib/server/application/ports";

export type InProcessEvent = {
	topic: string;
	payload: unknown;
	at: string;
};

/**
 * Lite-profile event bus. A publish() must never throw (so the app core runs
 * without Dapr), and published events are observable in-process. It does NOT
 * simulate cross-service delivery — the orchestrator/agent-runtime consumers
 * don't exist in lite; this only makes publishing a no-op-with-a-record.
 */
export class InProcessEventBus implements EventBus {
	private readonly emitter = new EventEmitter();
	private readonly buffer: InProcessEvent[] = [];

	constructor(private readonly ringSize = 256) {
		// Local subscribers only; nothing crosses a process boundary in lite.
		this.emitter.setMaxListeners(0);
	}

	async publish(topic: string, payload: unknown): Promise<void> {
		const event: InProcessEvent = { topic, payload, at: new Date().toISOString() };
		this.buffer.push(event);
		if (this.buffer.length > this.ringSize) this.buffer.shift();
		this.emitter.emit(topic, payload);
		this.emitter.emit("*", event);
	}

	/** Most-recent-first snapshot of the ring buffer (dev inspection only). */
	recent(limit = this.ringSize): InProcessEvent[] {
		return this.buffer.slice(-limit).reverse();
	}

	subscribe(topic: string, listener: (payload: unknown) => void): () => void {
		this.emitter.on(topic, listener);
		return () => this.emitter.off(topic, listener);
	}
}

/**
 * Lite-profile workflow scheduler. Durable SW workflows execute in the Python
 * orchestrator under Dapr placement, which the lite profile does not run — so
 * this is an explicit stub, NOT a fake. It records the intent, logs a single
 * structured warning, and returns a `lite-`-prefixed instance id that the
 * execution read-model recognises to surface a "requires a preview environment"
 * state. It deliberately does not simulate activity execution.
 */
export class LiteStubWorkflowScheduler implements WorkflowScheduler {
	async startSwWorkflow(
		input: WorkflowStartRequest,
	): Promise<{ instanceId?: string }> {
		const instanceId = `${LITE_WORKFLOW_INSTANCE_PREFIX}${randomUUID()}`;
		console.warn(
			`[lite] ${LITE_WORKFLOW_NOT_EXECUTED_MESSAGE} (workflowId=${input.workflowId}, dbExecutionId=${input.dbExecutionId}, instanceId=${instanceId})`,
		);
		return { instanceId };
	}
}

/**
 * Agent Event Bus
 *
 * Singleton EventEmitter + in-memory buffer for agent events.
 * Tracks agent state and workflow context.
 */

import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { AgentEvent, AgentEventType, AgentState, WorkflowContext } from "./types.js";

const MAX_EVENTS = 200;

class AgentEventBus extends EventEmitter {
	private events: AgentEvent[] = [];

	private state: AgentState = {
		status: "idle",
		currentActivity: null,
		runId: null,
		startedAt: null,
		toolNames: [],
		totalRuns: 0,
		totalTokens: 0,
		lastError: null,
	};

	private workflowContext: WorkflowContext = {
		workflowId: null,
		nodeId: null,
		stepIndex: null,
		receivedEvents: 0,
	};

	emitEvent(
		type: AgentEventType,
		data: Record<string, unknown>,
		callId?: string,
	): AgentEvent {
		const event: AgentEvent = {
			id: nanoid(),
			type,
			timestamp: new Date().toISOString(),
			runId: this.state.runId,
			callId,
			data,
		};

		this.events.push(event);
		if (this.events.length > MAX_EVENTS) {
			this.events = this.events.slice(-MAX_EVENTS);
		}

		this.emit("event", event);
		return event;
	}

	getState(): AgentState {
		return { ...this.state };
	}

	setState(partial: Partial<AgentState>): void {
		Object.assign(this.state, partial);
	}

	getWorkflowContext(): WorkflowContext {
		return { ...this.workflowContext };
	}

	setWorkflowContext(partial: Partial<WorkflowContext>): void {
		Object.assign(this.workflowContext, partial);
	}

	getRecentEvents(limit = 50): AgentEvent[] {
		const start = Math.max(0, this.events.length - limit);
		return this.events.slice(start).reverse();
	}
}

export const eventBus = new AgentEventBus();

/**
 * Agent Event Bus
 *
 * Singleton EventEmitter + in-memory buffer for agent events.
 * Tracks agent state and workflow context.
 */

import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type {
	AgentEvent,
	AgentEventType,
	AgentState,
	LogEntry,
	WorkflowContext,
} from "./types.js";

const MAX_EVENTS = 200;
const MAX_LOGS = 500;

class AgentEventBus extends EventEmitter {
	private events: AgentEvent[] = [];
	private logs: LogEntry[] = [];

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
		instanceId: null,
		status: null,
		traceId: null,
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

	addLog(level: LogEntry["level"], message: string): void {
		const entry: LogEntry = {
			id: nanoid(),
			level,
			timestamp: new Date().toISOString(),
			message,
		};
		this.logs.push(entry);
		if (this.logs.length > MAX_LOGS) {
			this.logs = this.logs.slice(-MAX_LOGS);
		}
		this.emit("log", entry);
	}

	getRecentLogs(limit = 100): LogEntry[] {
		const start = Math.max(0, this.logs.length - limit);
		return this.logs.slice(start);
	}
}

export const eventBus = new AgentEventBus();

/** Intercept console.log/warn/error/info to capture logs in the event bus */
export function interceptConsole(): void {
	const origLog = console.log;
	const origWarn = console.warn;
	const origError = console.error;
	const origInfo = console.info;

	console.log = (...args: unknown[]) => {
		origLog(...args);
		eventBus.addLog("log", args.map(String).join(" "));
	};
	console.warn = (...args: unknown[]) => {
		origWarn(...args);
		eventBus.addLog("warn", args.map(String).join(" "));
	};
	console.error = (...args: unknown[]) => {
		origError(...args);
		eventBus.addLog("error", args.map(String).join(" "));
	};
	console.info = (...args: unknown[]) => {
		origInfo(...args);
		eventBus.addLog("info", args.map(String).join(" "));
	};
}

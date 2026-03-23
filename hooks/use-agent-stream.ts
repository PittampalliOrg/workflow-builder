"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
	AgentStreamEvent,
	AgentStreamEventType,
} from "@/lib/types/agent-stream-events";

const MAX_BUFFERED_EVENTS = 200;

export type UseAgentStreamOptions = {
	/** Execution ID to stream events for */
	executionId: string | null;
	/** Whether streaming is enabled (e.g., only when run is active) */
	enabled?: boolean;
};

export type UseAgentStreamReturn = {
	/** Buffered events (most recent last) */
	events: AgentStreamEvent[];
	/** Whether the SSE connection is active */
	isConnected: boolean;
	/** Name of the currently running tool (if any) */
	activeToolName: string | null;
	/** Current agent phase */
	currentPhase: string | null;
	/** Recent tool call turns for timeline display */
	recentToolCalls: AgentStreamEvent[];
	/** Most recent LLM tokens (for streaming display) */
	llmTokenBuffer: string;
	/** Whether the LLM is currently generating */
	isLlmStreaming: boolean;
	/** Sandbox output events */
	sandboxOutputs: AgentStreamEvent[];
	/** Lines of output from the currently running sandbox command */
	activeSandboxLines: string[];
	/** Command currently executing in the sandbox (null when idle) */
	activeSandboxCommand: string | null;
};

export function useAgentStream({
	executionId,
	enabled = true,
}: UseAgentStreamOptions): UseAgentStreamReturn {
	const [events, setEvents] = useState<AgentStreamEvent[]>([]);
	const [isConnected, setIsConnected] = useState(false);
	const [activeToolName, setActiveToolName] = useState<string | null>(null);
	const [currentPhase, setCurrentPhase] = useState<string | null>(null);
	const [llmTokenBuffer, setLlmTokenBuffer] = useState("");
	const [isLlmStreaming, setIsLlmStreaming] = useState(false);
	const [activeSandboxLines, setActiveSandboxLines] = useState<string[]>([]);
	const [activeSandboxCommand, setActiveSandboxCommand] = useState<
		string | null
	>(null);

	const lastEventIdRef = useRef<string | null>(null);
	const eventSourceRef = useRef<EventSource | null>(null);

	useEffect(() => {
		setEvents([]);
		setIsConnected(false);
		setActiveToolName(null);
		setCurrentPhase(null);
		setLlmTokenBuffer("");
		setIsLlmStreaming(false);
		setActiveSandboxLines([]);
		setActiveSandboxCommand(null);
		lastEventIdRef.current = null;
		eventSourceRef.current?.close();
		eventSourceRef.current = null;
	}, [executionId]);

	const processEvent = useCallback((event: AgentStreamEvent) => {
		setEvents((prev) => {
			const next = [...prev, event];
			return next.length > MAX_BUFFERED_EVENTS
				? next.slice(-MAX_BUFFERED_EVENTS)
				: next;
		});

		switch (event.type) {
			case "tool_call_start":
			case "tool_start":
				setActiveToolName(event.toolName ?? null);
				break;
			case "tool_call_end":
			case "tool_complete":
			case "tool_call_error":
			case "tool_error":
				setActiveToolName(null);
				setActiveSandboxLines([]);
				setActiveSandboxCommand(null);
				break;
			case "sandbox_output_partial":
				if (event.output) {
					setActiveSandboxLines((prev) => [...prev, event.output!]);
				}
				if (event.command) {
					setActiveSandboxCommand(event.command);
				}
				break;
			case "sandbox_output":
				setActiveSandboxLines([]);
				setActiveSandboxCommand(null);
				break;
			case "sandbox_heartbeat":
				// Keep activeToolName alive during heartbeats — no state change needed
				break;
			case "llm_start":
			case "model_start":
				setIsLlmStreaming(true);
				setLlmTokenBuffer("");
				break;
			case "llm_token":
				if (event.token) {
					setLlmTokenBuffer((prev) => prev + event.token);
				}
				break;
			case "llm_complete":
			case "model_complete":
				setIsLlmStreaming(false);
				break;
			case "state_snapshot":
				if (event.phase) setCurrentPhase(event.phase);
				break;
			case "run_started":
				if (event.phase) setCurrentPhase(event.phase);
				break;
			case "run_complete":
			case "run_error":
				setActiveToolName(null);
				setIsLlmStreaming(false);
				setActiveSandboxLines([]);
				setActiveSandboxCommand(null);
				break;
		}

		if (event.phase) {
			setCurrentPhase(event.phase);
		}
	}, []);

	useEffect(() => {
		if (!executionId || !enabled || typeof window === "undefined") {
			return;
		}

		let url = `/api/workflows/executions/${executionId}/agent-stream`;
		// EventSource doesn't support custom headers, but we can pass Last-Event-ID via query
		if (lastEventIdRef.current) {
			url += `?lastEventId=${lastEventIdRef.current}`;
		}

		const source = new EventSource(url);
		eventSourceRef.current = source;

		source.addEventListener("agent_event", (e) => {
			const messageEvent = e as MessageEvent;
			try {
				const event = JSON.parse(messageEvent.data) as AgentStreamEvent;
				if (messageEvent.lastEventId) {
					lastEventIdRef.current = messageEvent.lastEventId;
				}
				processEvent(event);

				// Close on terminal events
				if (event.type === "run_complete" || event.type === "run_error") {
					source.close();
					setIsConnected(false);
				}
			} catch {
				// Ignore malformed events
			}
		});

		source.onopen = () => {
			setIsConnected(true);
		};

		source.onerror = () => {
			setIsConnected(false);
			// EventSource auto-reconnects; let it try
		};

		return () => {
			source.close();
			eventSourceRef.current = null;
			setIsConnected(false);
		};
	}, [executionId, enabled, processEvent]);

	// Derived state
	const recentToolCalls = events.filter(
		(e) =>
			e.type === "tool_call_start" ||
			e.type === "tool_start" ||
			e.type === "tool_call_end" ||
			e.type === "tool_complete" ||
			e.type === "tool_call_error" ||
			e.type === "tool_error",
	);

	const sandboxOutputs = events.filter((e) => e.type === "sandbox_output");

	return {
		events,
		isConnected,
		activeToolName,
		currentPhase,
		recentToolCalls,
		llmTokenBuffer,
		isLlmStreaming,
		sandboxOutputs,
		activeSandboxLines,
		activeSandboxCommand,
	};
}

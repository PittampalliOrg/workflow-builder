import type { SessionEventEnvelope } from '$lib/types/sessions';
import type { ExecutionTimelineEvent } from '$lib/types/execution-stream';

export interface ToolPairEvent {
	id: string | number;
	type: string;
	data: Record<string, unknown>;
}

export interface ToolPair<E extends ToolPairEvent = ToolPairEvent> {
	start?: E;
	end?: E;
}

const START_TYPES = new Set([
	'agent.tool_use',
	'agent.mcp_tool_use',
	'agent.custom_tool_use',
	'tool_call_start'
]);

const END_TYPES = new Set([
	'agent.tool_result',
	'agent.mcp_tool_result',
	'agent.custom_tool_result',
	'tool_call_end',
	'tool_call_error'
]);

function extractToolUseId(data: Record<string, unknown>): string | null {
	if (typeof data.tool_use_id === 'string' && data.tool_use_id) return data.tool_use_id;
	if (typeof data.toolCallId === 'string' && data.toolCallId) return data.toolCallId;
	if (typeof data.tool_call_id === 'string' && data.tool_call_id) return data.tool_call_id;
	if (typeof data.callId === 'string' && data.callId) return data.callId;
	return null;
}

function extractToolName(data: Record<string, unknown>): string | null {
	if (typeof data.name === 'string' && data.name) return data.name;
	if (typeof data.tool_name === 'string' && data.tool_name) return data.tool_name;
	return null;
}

/**
 * Given a flat list of events (chronological order) and a single selected
 * event that is either a tool_use or a tool_result, find the matching mate.
 *
 * Strategy: prefer `tool_use_id` when both events stamp it (CMA contract);
 * fall back to FIFO-by-tool-name pairing across the full event stream — this
 * matches `buildTimelineItems` and copes with the dapr-agent-py case where
 * `tool_use_id` is not propagated through the event envelope.
 *
 * Returns `{start, end}` populated to whatever was found. If `selected` is not
 * a tool event at all, returns `{}`.
 */
export function findToolPair<E extends ToolPairEvent>(
	events: readonly E[],
	selected: E | null | undefined
): ToolPair<E> {
	if (!selected) return {};
	const selectedIsStart = START_TYPES.has(selected.type);
	const selectedIsEnd = END_TYPES.has(selected.type);
	if (!selectedIsStart && !selectedIsEnd) return {};

	const targetId = extractToolUseId(selected.data);
	if (targetId) {
		let mate: E | undefined;
		for (const e of events) {
			if (e === selected) continue;
			if (selectedIsStart && !END_TYPES.has(e.type)) continue;
			if (selectedIsEnd && !START_TYPES.has(e.type)) continue;
			if (extractToolUseId(e.data) === targetId) {
				mate = e;
				break;
			}
		}
		if (mate) {
			return selectedIsStart ? { start: selected, end: mate } : { start: mate, end: selected };
		}
	}

	// Fallback: positional FIFO by tool name. Walk the whole stream once,
	// pairing starts with the next end of the same tool name. Then return
	// whichever pair contains the selected event.
	const targetName = extractToolName(selected.data);
	if (!targetName) {
		return selectedIsStart ? { start: selected } : { end: selected };
	}
	const openByName = new Map<string, E[]>();
	const pairs: Array<{ start: E; end?: E }> = [];
	const startToPair = new Map<E, { start: E; end?: E }>();
	const endToPair = new Map<E, { start: E; end?: E }>();
	for (const e of events) {
		if (START_TYPES.has(e.type)) {
			const n = extractToolName(e.data);
			if (!n) continue;
			const queue = openByName.get(n) ?? [];
			queue.push(e);
			openByName.set(n, queue);
			const p = { start: e } as { start: E; end?: E };
			pairs.push(p);
			startToPair.set(e, p);
		} else if (END_TYPES.has(e.type)) {
			const n = extractToolName(e.data);
			if (!n) continue;
			const queue = openByName.get(n);
			const matchedStart = queue?.shift();
			if (matchedStart) {
				const p = startToPair.get(matchedStart);
				if (p) {
					p.end = e;
					endToPair.set(e, p);
				}
			}
		}
	}

	if (selectedIsStart) {
		const p = startToPair.get(selected);
		return p ? { start: p.start, end: p.end } : { start: selected };
	}
	const p = endToPair.get(selected);
	return p ? { start: p.start, end: p.end } : { end: selected };
}

/**
 * Walk forward from a tool_use event to find the next `agent.llm_usage` event
 * with a matching `tool_use_id` (or, when not stamped, the next llm_usage
 * after this tool's `tool_result`). Returns null if no usage is associated.
 *
 * Kept for back-compat with callers that need a single-event lookup.
 * Prefer `computeTokenAssignments` for the list-row case.
 */
export function findToolTokenUsage<E extends ToolPairEvent & { sequence?: number }>(
	events: readonly E[],
	toolUseEvent: E
): { input: number; output: number } | null {
	if (!START_TYPES.has(toolUseEvent.type)) return null;
	const targetId = extractToolUseId(toolUseEvent.data);
	const startIdx = events.indexOf(toolUseEvent);
	if (startIdx < 0) return null;
	for (let i = startIdx + 1; i < events.length; i++) {
		const e = events[i];
		if (e.type !== 'agent.llm_usage' && e.type !== 'span.model_request_end') continue;
		if (targetId) {
			const id = extractToolUseId(e.data);
			if (id && id !== targetId) continue;
		}
		const d = e.data as { input_tokens?: number; output_tokens?: number; model_usage?: { input_tokens?: number; output_tokens?: number } };
		const usage = d.model_usage ?? d;
		const input = Number(usage.input_tokens ?? 0);
		const output = Number(usage.output_tokens ?? 0);
		if (input || output) return { input, output };
		return null;
	}
	return null;
}

/**
 * Walk the entire event stream once and assign each `agent.llm_usage`
 * event's tokens to the FIRST content event (agent.message OR tool_use)
 * that appeared after the previous llm_usage — matching CMA's display
 * heuristic where tokens cluster with the row that "consumed" them.
 *
 * For a turn where the LLM produced a text message AND tool calls in one
 * response, only the message gets tokens (the tools share the call). For
 * tool-only turns, the first tool_use gets tokens.
 *
 * Returns a Map keyed by event id so list rows can do an O(1) lookup
 * instead of an O(N) walk per row.
 */
export function computeTokenAssignments<E extends ToolPairEvent>(
	events: readonly E[]
): Map<string | number, { input: number; output: number }> {
	const assignments = new Map<string | number, { input: number; output: number }>();
	let pendingOwner: E | null = null;
	for (const e of events) {
		const isContent = e.type === 'agent.message' || START_TYPES.has(e.type);
		if (isContent && pendingOwner === null) {
			pendingOwner = e;
			continue;
		}
		if (e.type === 'agent.llm_usage' && pendingOwner) {
			const d = e.data as {
				input_tokens?: number;
				output_tokens?: number;
				model_usage?: { input_tokens?: number; output_tokens?: number };
			};
			const usage = d.model_usage ?? d;
			const input = Number(usage.input_tokens ?? 0);
			const output = Number(usage.output_tokens ?? 0);
			if (input || output) {
				assignments.set(pendingOwner.id, { input, output });
			}
			pendingOwner = null;
		}
	}
	return assignments;
}

export type { SessionEventEnvelope, ExecutionTimelineEvent };

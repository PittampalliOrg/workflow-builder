import type { ExecutionTimelineEvent } from '$lib/types/execution-stream';

export type TimelineItem =
	| {
			kind: 'event';
			key: string;
			event: ExecutionTimelineEvent;
	  }
	| {
			kind: 'tool';
			key: string;
			toolName: string;
			args?: Record<string, unknown>;
			output: string;
			error: string;
			success: boolean;
			status: 'running' | 'completed' | 'error' | 'unknown';
			phase: 'start' | 'end';
			startEvent?: ExecutionTimelineEvent;
			endEvent?: ExecutionTimelineEvent;
	  };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function eventType(event: ExecutionTimelineEvent): string {
	const nestedData = isRecord(event.data?.data) ? event.data.data : null;
	return event.type === 'com.dapr.event.sent'
		? stringValue(nestedData?.type) || stringValue(event.data?.type) || event.type
		: event.type || stringValue(event.data?.type) || stringValue(nestedData?.type) || '';
}

export function eventToolName(event: ExecutionTimelineEvent): string {
	const nestedData = isRecord(event.data?.data) ? event.data.data : null;
	return (
		stringValue(event.toolName) ??
		stringValue(event.data?.toolName) ??
		stringValue(nestedData?.toolName) ??
		stringValue(event.data?.name) ??
		stringValue(nestedData?.name) ??
		'Tool'
	);
}

function eventCallId(event: ExecutionTimelineEvent): string | null {
	return (
		stringValue(event.callId) ??
		stringValue(event.data?.callId) ??
		stringValue(event.data?.toolCallId) ??
		stringValue(event.data?.tool_call_id)
	);
}

export function eventKey(event: ExecutionTimelineEvent): string {
	const sourceEventId =
		stringValue(event.sourceEventId) ??
		stringValue(event.data?.sourceEventId) ??
		stringValue(event.data?.id);
	const daprInstanceId =
		stringValue(event.daprInstanceId) ?? stringValue(event.data?.daprInstanceId);
	if (sourceEventId) {
		return `source:${daprInstanceId ?? 'unknown'}:${sourceEventId}`;
	}
	if (event.id !== undefined && event.id !== null) {
		return `id:${event.id}`;
	}
	return [
		'event',
		daprInstanceId ?? 'unknown',
		eventType(event) || 'unknown',
		event.timestamp || 'unknown',
		eventToolName(event)
	].join(':');
}

function eventTime(event: ExecutionTimelineEvent): number {
	const parsed = Date.parse(event.timestamp);
	return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function mergeEvent(previous: ExecutionTimelineEvent, next: ExecutionTimelineEvent): ExecutionTimelineEvent {
	return {
		...previous,
		...next,
		data: {
			...(previous.data ?? {}),
			...(next.data ?? {})
		},
		id: previous.id ?? next.id,
		type: next.type || previous.type,
		timestamp: previous.timestamp || next.timestamp
	};
}

export function mergeTimelineEvents(
	...sources: Array<ExecutionTimelineEvent[] | null | undefined>
): ExecutionTimelineEvent[] {
	const byKey = new Map<string, ExecutionTimelineEvent>();

	for (const source of sources) {
		for (const rawEvent of source ?? []) {
			if (!rawEvent) continue;
			const event = {
				...rawEvent,
				type: eventType(rawEvent),
				data: rawEvent.data ?? {}
			};
			const key = eventKey(event);
			const previous = byKey.get(key);
			byKey.set(key, previous ? mergeEvent(previous, event) : event);
		}
	}

	return Array.from(byKey.values()).sort((a, b) => {
		const byTime = eventTime(a) - eventTime(b);
		if (byTime !== 0) return byTime;
		return eventKey(a).localeCompare(eventKey(b));
	});
}

function hasNestedIsError(value: unknown, depth = 0): boolean {
	if (depth > 4) return false;
	if (value === true) return false;
	if (isRecord(value)) {
		if (value.isError === true || value.error === true) return true;
		return Object.values(value).some((entry) => hasNestedIsError(entry, depth + 1));
	}
	if (Array.isArray(value)) {
		return value.some((entry) => hasNestedIsError(entry, depth + 1));
	}
	return false;
}

function parseOutput(output: string): unknown {
	if (!output.trim()) return null;
	try {
		return JSON.parse(output);
	} catch {
		return null;
	}
}

function toolOutcome(event: ExecutionTimelineEvent) {
	const data = event.data ?? {};
	const output = typeof data.output === 'string' ? data.output : '';
	const error = typeof data.error === 'string' ? data.error : '';
	const parsedOutput = parseOutput(output);
	const embeddedError =
		data.isError === true ||
		hasNestedIsError(data) ||
		hasNestedIsError(parsedOutput) ||
		/^error executing tool\b/i.test(output.trim());
	const success = eventType(event) !== 'tool_call_error' && data.success !== false && !error && !embeddedError;

	return { output, error, success };
}

function completeToolItem(
	item: Extract<TimelineItem, { kind: 'tool' }>,
	endEvent: ExecutionTimelineEvent
) {
	const outcome = toolOutcome(endEvent);
	item.endEvent = endEvent;
	item.output = outcome.output;
	item.error = outcome.error;
	item.success = outcome.success;
	item.status = outcome.success ? 'completed' : 'error';
	item.phase = 'end';
}

export function buildTimelineItems(
	events: ExecutionTimelineEvent[],
	options?: { isRunning?: boolean }
): TimelineItem[] {
	const items: TimelineItem[] = [];
	const openByCallId = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>();
	const openByTool = new Map<string, Array<Extract<TimelineItem, { kind: 'tool' }>>>();

	function enqueueTool(toolName: string, item: Extract<TimelineItem, { kind: 'tool' }>) {
		const queue = openByTool.get(toolName) ?? [];
		queue.push(item);
		openByTool.set(toolName, queue);

		const callId = item.startEvent ? eventCallId(item.startEvent) : null;
		if (callId) openByCallId.set(callId, item);
	}

	function dequeueTool(endEvent: ExecutionTimelineEvent) {
		const callId = eventCallId(endEvent);
		if (callId) {
			const byCallId = openByCallId.get(callId);
			if (byCallId) {
				openByCallId.delete(callId);
				const queue = openByTool.get(byCallId.toolName);
				if (queue) {
					const index = queue.indexOf(byCallId);
					if (index >= 0) queue.splice(index, 1);
				}
				return byCallId;
			}
		}

		const toolName = eventToolName(endEvent);
		const queue = openByTool.get(toolName);
		const item = queue?.shift() ?? null;
		if (item?.startEvent) {
			const startCallId = eventCallId(item.startEvent);
			if (startCallId) openByCallId.delete(startCallId);
		}
		return item;
	}

	for (const event of events) {
		const type = eventType(event);
		if (type === 'tool_call_start') {
			const toolName = eventToolName(event);
			const args = isRecord(event.data?.args) ? event.data.args : undefined;
			const item: Extract<TimelineItem, { kind: 'tool' }> = {
				kind: 'tool',
				key: `tool:${eventKey(event)}`,
				toolName,
				args,
				output: '',
				error: '',
				success: true,
				status: 'running',
				phase: 'start',
				startEvent: event
			};
			enqueueTool(toolName, item);
			items.push(item);
			continue;
		}

		if (type === 'tool_call_end' || type === 'tool_call_error') {
			const item = dequeueTool(event);
			if (item) {
				completeToolItem(item, event);
			} else {
				const outcome = toolOutcome(event);
				items.push({
					kind: 'tool',
					key: `tool:${eventKey(event)}`,
					toolName: eventToolName(event),
					output: outcome.output,
					error: outcome.error,
					success: outcome.success,
					status: outcome.success ? 'completed' : 'error',
					phase: 'end',
					endEvent: event
				});
			}
			continue;
		}

		items.push({
			kind: 'event',
			key: `event:${eventKey(event)}`,
			event
		});
	}

	if (!options?.isRunning) {
		for (const item of items) {
			if (item.kind === 'tool' && item.status === 'running') {
				item.status = 'unknown';
				item.success = false;
				item.error = item.error || 'No completion event received.';
			}
		}
	}

	return items;
}

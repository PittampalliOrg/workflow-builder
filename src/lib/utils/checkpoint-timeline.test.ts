import { describe, expect, it } from 'vitest';
import { injectCheckpointMarkers, isMarkerCheckpoint, timelineItemTimestamp } from './checkpoint-timeline';
import type { TimelineItem } from './execution-timeline';
import type { CodeCheckpoint } from './code-checkpoints';

function eventItem(key: string, timestamp: string): TimelineItem {
	return {
		kind: 'event',
		key,
		event: { type: 'agent.message', data: {}, timestamp } as never
	};
}

function toolItem(key: string, timestamp: string): TimelineItem {
	return {
		kind: 'tool',
		key,
		toolName: 'write_file',
		output: '',
		error: '',
		success: true,
		status: 'completed',
		phase: 'end',
		endEvent: { type: 'tool_call_end', data: {}, timestamp } as never
	};
}

function checkpoint(id: string, createdAt: string, status: CodeCheckpoint['status'] = 'created'): CodeCheckpoint {
	return {
		id,
		seq: 1,
		toolName: 'write_file',
		status,
		beforeSha: 'a',
		afterSha: 'b',
		remoteUrl: null,
		remoteRef: null,
		remoteStatus: null,
		remoteError: null,
		remotePushedAt: null,
		changedFiles: [],
		fileCount: 1,
		sourceEventId: 'e',
		sandboxName: null,
		repoPath: '/w',
		error: null,
		createdAt
	};
}

describe('isMarkerCheckpoint', () => {
	it('surfaces created and error checkpoints only', () => {
		expect(isMarkerCheckpoint(checkpoint('c', '2026-01-01T00:00:00Z', 'created'))).toBe(true);
		expect(isMarkerCheckpoint(checkpoint('c', '2026-01-01T00:00:00Z', 'error'))).toBe(true);
		expect(isMarkerCheckpoint(checkpoint('c', '2026-01-01T00:00:00Z', 'no_changes'))).toBe(false);
		expect(isMarkerCheckpoint(checkpoint('c', '2026-01-01T00:00:00Z', 'skipped'))).toBe(false);
	});
});

describe('timelineItemTimestamp', () => {
	it('reads tool end timestamp and event timestamp', () => {
		expect(timelineItemTimestamp(toolItem('t', '2026-01-01T00:00:05Z'))).toBe(Date.parse('2026-01-01T00:00:05Z'));
		expect(timelineItemTimestamp(eventItem('e', '2026-01-01T00:00:06Z'))).toBe(Date.parse('2026-01-01T00:00:06Z'));
	});
});

describe('injectCheckpointMarkers', () => {
	it('interleaves checkpoints between items by timestamp', () => {
		const items = [
			eventItem('e1', '2026-01-01T00:00:01Z'),
			toolItem('t1', '2026-01-01T00:00:03Z'),
			eventItem('e2', '2026-01-01T00:00:05Z')
		];
		const checkpoints = [checkpoint('cp1', '2026-01-01T00:00:04Z')];
		const merged = injectCheckpointMarkers(items, checkpoints);
		expect(merged.map((m) => m.key)).toEqual(['it:e1', 'it:t1', 'cp:cp1', 'it:e2']);
	});

	it('appends checkpoints later than every item', () => {
		const items = [eventItem('e1', '2026-01-01T00:00:01Z')];
		const checkpoints = [checkpoint('cp1', '2026-01-01T00:00:09Z')];
		const merged = injectCheckpointMarkers(items, checkpoints);
		expect(merged.map((m) => m.key)).toEqual(['it:e1', 'cp:cp1']);
	});

	it('drops non-marker checkpoints', () => {
		const items = [eventItem('e1', '2026-01-01T00:00:01Z')];
		const checkpoints = [checkpoint('cp1', '2026-01-01T00:00:02Z', 'no_changes')];
		const merged = injectCheckpointMarkers(items, checkpoints);
		expect(merged.map((m) => m.key)).toEqual(['it:e1']);
	});

	it('emits a checkpoint before an item that post-dates it', () => {
		const items = [eventItem('e1', '2026-01-01T00:00:10Z')];
		const checkpoints = [checkpoint('cp1', '2026-01-01T00:00:02Z')];
		const merged = injectCheckpointMarkers(items, checkpoints);
		expect(merged.map((m) => m.key)).toEqual(['cp:cp1', 'it:e1']);
	});
});

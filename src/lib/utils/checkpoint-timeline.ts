/**
 * Interleave code-checkpoint markers into the run Timeline feed.
 *
 * The Timeline renders `TimelineItem`s (agent messages + tool pairs) in event
 * order. Checkpoints are captured at mutating-tool boundaries, so a checkpoint's
 * `createdAt` slots naturally between timeline items. This produces a single
 * ordered list the Timeline tab can render, tagging each entry so the view can
 * draw a checkpoint marker (icon + tool + ±line chip) that selects the
 * checkpoint in the Code tab on click.
 */
import type { TimelineItem } from './execution-timeline';
import type { CodeCheckpoint } from './code-checkpoints';

export type CheckpointTimelineEntry =
	| { kind: 'item'; key: string; item: TimelineItem }
	| { kind: 'checkpoint'; key: string; checkpoint: CodeCheckpoint };

function parseTs(value: string | null | undefined): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? null : parsed;
}

/** Best-effort event timestamp for a timeline item (tool end/start or event). */
export function timelineItemTimestamp(item: TimelineItem): number | null {
	if (item.kind === 'tool') {
		return parseTs(item.endEvent?.timestamp) ?? parseTs(item.startEvent?.timestamp);
	}
	return parseTs(item.event?.timestamp);
}

/** Checkpoints worth surfacing as timeline markers (real mutations + failures). */
export function isMarkerCheckpoint(checkpoint: CodeCheckpoint): boolean {
	return checkpoint.status === 'created' || checkpoint.status === 'error';
}

/**
 * Merge timeline items with checkpoint markers in chronological order.
 *
 * Items keep their existing (already event-ordered) sequence; a checkpoint is
 * emitted just before the first item whose timestamp is later than the
 * checkpoint's `createdAt`. Items without a parseable timestamp inherit the last
 * seen timestamp so ordering never regresses. Any checkpoints later than every
 * item are appended at the end.
 */
export function injectCheckpointMarkers(
	items: TimelineItem[],
	checkpoints: CodeCheckpoint[]
): CheckpointTimelineEntry[] {
	const markers = checkpoints
		.filter(isMarkerCheckpoint)
		.map((checkpoint) => ({ checkpoint, ts: parseTs(checkpoint.createdAt) }))
		.sort((a, b) => (a.ts ?? Infinity) - (b.ts ?? Infinity));

	const out: CheckpointTimelineEntry[] = [];
	let markerIdx = 0;
	let lastTs = -Infinity;

	const emitMarkersUpTo = (limit: number) => {
		while (markerIdx < markers.length) {
			const ts = markers[markerIdx].ts;
			if (ts === null || ts > limit) break;
			const checkpoint = markers[markerIdx].checkpoint;
			out.push({ kind: 'checkpoint', key: `cp:${checkpoint.id}`, checkpoint });
			markerIdx += 1;
		}
	};

	for (const item of items) {
		const ts = timelineItemTimestamp(item) ?? lastTs;
		if (ts > lastTs) lastTs = ts;
		emitMarkersUpTo(ts);
		out.push({ kind: 'item', key: `it:${item.key}`, item });
	}

	// Trailing checkpoints (after the last item, or with unparseable timestamps).
	while (markerIdx < markers.length) {
		const checkpoint = markers[markerIdx].checkpoint;
		out.push({ kind: 'checkpoint', key: `cp:${checkpoint.id}`, checkpoint });
		markerIdx += 1;
	}

	return out;
}

import type { SessionEventEnvelope } from '$lib/types/sessions';
import type { ExecutionTimelineEvent } from '$lib/types/execution-stream';
import type { ToolPair } from '$lib/utils/tool-pair';

export type EventRendererVariant = 'card' | 'panel';

/**
 * The renderer accepts either CMA session envelopes or workflow timeline
 * envelopes — both expose `type: string` + `data: Record<string, unknown>`,
 * which is everything the per-kind renderers need. Other fields (id,
 * timestamp, etc.) are read opportunistically when present.
 */
export type RenderableEvent = SessionEventEnvelope | ExecutionTimelineEvent;

export type RenderableToolPair = ToolPair<RenderableEvent>;

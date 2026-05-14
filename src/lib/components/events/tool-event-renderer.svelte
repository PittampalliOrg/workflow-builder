<script lang="ts">
	import { getToolComponent } from '$lib/components/workflow/execution/tool-views';
	import {
		eventToolName,
		isToolStartType,
		isToolEndType,
		toolOutcome,
		extractImageDataUrl,
		extractStepMeta
	} from '$lib/utils/execution-timeline';
	import type { ExecutionTimelineEvent } from '$lib/types/execution-stream';
	import type { EventRendererVariant, RenderableEvent, RenderableToolPair } from './types';

	interface Props {
		/** Either a single event or a pre-built pair. When given a pair the
		 *  start half supplies args and the end half supplies output/error. */
		pair?: RenderableToolPair;
		event?: RenderableEvent;
		variant?: EventRendererVariant;
		/** Optional explicit overrides — used by the workflow timeline which
		 *  pre-extracts these from `TimelineItem`. */
		toolNameOverride?: string;
		argsOverride?: Record<string, unknown>;
		stateOverride?: 'running' | 'completed' | 'error' | 'pending';
		hasFullPayload?: boolean;
		onLoadFull?: () => void;
		loadingFull?: boolean;
	}

	let {
		pair,
		event,
		variant = 'card',
		toolNameOverride,
		argsOverride,
		stateOverride
	}: Props = $props();

	function asTimeline(e: RenderableEvent | undefined): ExecutionTimelineEvent | undefined {
		// Both shapes have `type: string` + `data: Record<string, unknown>`,
		// which is everything the helpers actually inspect. Cast widens.
		return e as unknown as ExecutionTimelineEvent | undefined;
	}

	const startEvent = $derived.by<RenderableEvent | undefined>(() => {
		if (pair?.start) return pair.start;
		if (event && isToolStartType(event.type)) return event;
		return undefined;
	});

	const endEvent = $derived.by<RenderableEvent | undefined>(() => {
		if (pair?.end) return pair.end;
		if (event && isToolEndType(event.type)) return event;
		return undefined;
	});

	const toolName = $derived.by(() => {
		if (toolNameOverride) return toolNameOverride;
		if (endEvent) return eventToolName(asTimeline(endEvent)!);
		if (startEvent) return eventToolName(asTimeline(startEvent)!);
		return 'Tool';
	});

	const args = $derived.by<Record<string, unknown> | undefined>(() => {
		if (argsOverride) return argsOverride;
		const data = startEvent?.data;
		if (!data || typeof data !== 'object') return undefined;
		const r = data as Record<string, unknown>;
		// CMA: agent.tool_use carries args under `input`. Legacy: `args`.
		const candidate = (r.args && typeof r.args === 'object') ? r.args
			: (r.input && typeof r.input === 'object') ? r.input
			: undefined;
		return candidate as Record<string, unknown> | undefined;
	});

	const outcome = $derived.by(() => {
		if (!endEvent) return { output: '', error: '', success: true };
		return toolOutcome(asTimeline(endEvent)!);
	});

	const phase = $derived(endEvent ? ('end' as const) : ('start' as const));

	const computedState = $derived.by<'running' | 'completed' | 'error' | 'pending'>(() => {
		if (stateOverride) return stateOverride;
		if (!endEvent) return 'running';
		return outcome.success ? 'completed' : 'error';
	});

	const imageUrl = $derived(endEvent ? extractImageDataUrl(asTimeline(endEvent)!) : undefined);
	const stepMeta = $derived(endEvent ? extractStepMeta(asTimeline(endEvent)!) : { stepNumber: undefined, url: undefined });

	const ToolComponent = $derived(getToolComponent(toolName));
</script>

<ToolComponent
	{phase}
	{toolName}
	{args}
	output={outcome.output}
	error={outcome.error}
	success={outcome.success}
	state={computedState}
	{variant}
/>

{#if imageUrl && variant === 'panel'}
	<figure class="mt-2 flex flex-col gap-1 rounded-md border border-border/40 bg-muted/20 p-2">
		<img
			src={imageUrl}
			alt={`Browser state${stepMeta.stepNumber !== undefined ? ` after step ${stepMeta.stepNumber}` : ''}`}
			loading="lazy"
			class="max-h-[60vh] w-full rounded border border-border/30 object-contain"
		/>
		{#if stepMeta.stepNumber !== undefined || stepMeta.url}
			<figcaption class="text-[11px] text-muted-foreground">
				{#if stepMeta.stepNumber !== undefined}Step {stepMeta.stepNumber}{/if}
				{#if stepMeta.stepNumber !== undefined && stepMeta.url} · {/if}
				{#if stepMeta.url}<span class="truncate">{stepMeta.url}</span>{/if}
			</figcaption>
		{/if}
	</figure>
{/if}

{#if variant === 'panel' && phase === 'start' && !endEvent}
	<div class="mt-2 rounded border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
		Result not yet available — the tool call hasn't completed.
	</div>
{/if}

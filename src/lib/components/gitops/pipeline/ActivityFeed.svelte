<script lang="ts">
	import { Radio, ChevronDown, ChevronRight } from "@lucide/svelte";

	import {
		activityEventLabel,
		correlationChips,
		selectionForEvent,
	} from "$lib/gitops/activity-overlay";
	import { activityEventTone, toneClasses } from "$lib/gitops/activity-tone";
	import JsonViewer from "$lib/components/workflow/execution/json-viewer.svelte";
	import { relativeTime } from "$lib/utils/gitops-display";
	import type { PipelineModel } from "$lib/gitops/pipeline-types";
	import type { PipelineSelection } from "$lib/components/gitops/pipeline/PipelineGraph.svelte";
	import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";

	const MAX_ROWS = 80;

	interface Props {
		events: GitOpsActivityEvent[];
		now: number;
		/** When provided (with onNavigate), event rows get a click-to-stage chip. */
		model?: PipelineModel | null;
		onNavigate?: (sel: PipelineSelection) => void;
	}

	let { events, now, model = null, onNavigate }: Props = $props();

	// `events` arrives newest-first from `mergeActivityEvents` — slice, don't re-sort.
	const recent = $derived(events.slice(0, MAX_ROWS));
	const latest = $derived(events[0] ?? null);

	let expandedId = $state<string | null>(null);

	function targetLabel(sel: NonNullable<PipelineSelection>): string {
		if (sel.kind === "stage") {
			const name = sel.id.replace(/^stage\//, "");
			return name.replace("::", " · ");
		}
		return sel.id.replace(/^warehouse\//, "");
	}

	function navigate(e: Event, sel: PipelineSelection) {
		e.stopPropagation();
		if (sel) onNavigate?.(sel);
	}
</script>

<div class="flex flex-col">
	<div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs">
		<span class="font-medium text-foreground">
			{events.length} event{events.length === 1 ? "" : "s"}
		</span>
		{#if latest}
			<span class="flex items-center gap-1.5 font-mono text-[0.62rem] text-muted-foreground">
				<span>#{latest.sequence}</span>
				<span>·</span>
				<span>{relativeTime(latest.observedAt, now)}</span>
			</span>
		{/if}
	</div>

	{#if recent.length === 0}
		<div class="px-3 py-4 text-center text-xs text-muted-foreground">Waiting for events…</div>
	{:else}
		<div class="max-h-96 space-y-0.5 overflow-y-auto p-2">
			{#each recent as event (event.eventId)}
				{@const tone = activityEventTone(event, now)}
				{@const expanded = event.eventId === expandedId}
				{@const target = model && onNavigate ? selectionForEvent(event, model) : null}
				<div>
					<button
						type="button"
						class="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/40"
						onclick={() => (expandedId = expanded ? null : event.eventId)}
					>
						<span
							class="mt-0.5 h-3.5 w-0.5 shrink-0 rounded-full {toneClasses(tone).dot} {tone === 'active'
								? 'animate-pulse'
								: ''}"
						></span>
						<span class="min-w-0 flex-1">
							<span class="flex items-center justify-between gap-2">
								<span class="flex min-w-0 items-center gap-1 text-xs font-medium text-foreground">
									{#if tone === "active"}
										<Radio class="size-3 shrink-0 animate-pulse text-sky-500" />
									{/if}
									<span class="truncate">{activityEventLabel(event)}</span>
								</span>
								<span class="flex shrink-0 items-center gap-1.5">
									{#if target}
										<!-- svelte-ignore node_invalid_placement_ssr -->
										<span
											role="link"
											tabindex="-1"
											class="inline-flex max-w-36 items-center gap-1 rounded border border-border/70 bg-muted/50 px-1 py-px text-[0.58rem] text-muted-foreground transition hover:border-primary/50 hover:text-foreground"
											title={`Open ${targetLabel(target)}`}
											onclick={(e) => navigate(e, target)}
											onkeydown={(e) => {
												if (e.key === "Enter") navigate(e, target);
											}}
										>
											{#if model}
												{@const warehouseName = target.kind === "stage" ? target.id.replace(/^stage\//, "").split("::")[0] : target.id.replace(/^warehouse\//, "")}
												<span
													class="size-1.5 shrink-0 rounded-full"
													style={`background:${model.warehouseColorMap[warehouseName] ?? "#9ca3af"}`}
												></span>
											{/if}
											<span class="truncate">{targetLabel(target)}</span>
										</span>
									{/if}
									<span class="font-mono text-[0.58rem] text-muted-foreground">
										{relativeTime(event.observedAt, now)}
									</span>
								</span>
							</span>
							<span
								class="block truncate text-[0.62rem] text-muted-foreground"
								title={event.activityType}
							>
								{event.phase ?? "event"}{event.reason ? ` · ${event.reason}` : ""}
							</span>
							{#if event.message}
								<span
									class="block truncate text-[0.62rem] text-muted-foreground/80"
									title={event.message}
								>
									{event.message}
								</span>
							{/if}
						</span>
						{#if expanded}
							<ChevronDown class="mt-0.5 size-3 shrink-0 text-muted-foreground" />
						{:else}
							<ChevronRight class="mt-0.5 size-3 shrink-0 text-muted-foreground" />
						{/if}
					</button>
					{#if expanded}
						{@const chips = correlationChips(event)}
						<div class="space-y-1.5 px-2 pb-1.5">
							{#if chips.length > 0}
								<div class="flex flex-wrap gap-1">
									{#each chips as chip (chip.key)}
										<span class="inline-flex items-center gap-1 rounded border border-border/70 bg-muted/40 px-1.5 py-px font-mono text-[0.6rem]">
											<span class="text-muted-foreground">{chip.key}</span>
											<span class="text-foreground">{chip.label}</span>
										</span>
									{/each}
								</div>
							{/if}
							<JsonViewer data={event.raw} collapsed />
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>

<script lang="ts">
	import { Check, X, Loader2, Circle, ChevronDown, ChevronRight } from 'lucide-svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import JsonViewer from './json-viewer.svelte';
	import CollapsibleSection from './collapsible-section.svelte';

	interface StepLog {
		logId?: string;
		stepName: string;
		label: string;
		displayLabel?: string;
		actionType: string;
		status: string;
		input: unknown;
		output: unknown;
		error: string | null;
		durationMs: number | null;
		attempt?: number;
		attemptsTotal?: number;
	}

	interface Props {
		steps: StepLog[];
	}

	let { steps }: Props = $props();

	let expandedSteps = new SvelteSet<number>();

	function toggleStep(index: number) {
		if (expandedSteps.has(index)) {
			expandedSteps.delete(index);
		} else {
			expandedSteps.add(index);
		}
	}

	function formatDuration(ms: number | null): string {
		if (ms === null) return '';
		if (ms < 1000) return `${ms}ms`;
		if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
	}

	function statusDotColor(status: string): string {
		switch (status) {
			case 'success': return 'bg-green-500';
			case 'error': return 'bg-red-500';
			case 'running': return 'bg-blue-500';
			default: return 'bg-muted-foreground/50';
		}
	}
</script>

<div class="space-y-0">
	{#each steps as step, i (i)}
		{@const isFirst = i === 0}
		{@const isLast = i === steps.length - 1}
		{@const isExpanded = expandedSteps.has(i)}

		<div class="relative flex gap-3">
			<!-- Timeline connector -->
			<div class="relative -ml-px flex flex-col items-center pt-2" style="width: 20px;">
				<!-- Top connector line -->
				{#if !isFirst}
					<div class="absolute bottom-full h-2 w-px bg-border"></div>
				{/if}

				<!-- Status dot (h-5 w-5 — matches card header dots) -->
				<div class="z-10 flex h-5 w-5 shrink-0 items-center justify-center rounded-full {statusDotColor(step.status)}">
					{#if step.status === 'success'}
						<Check size={11} class="text-white" strokeWidth={3} />
					{:else if step.status === 'error'}
						<X size={11} class="text-white" strokeWidth={3} />
					{:else if step.status === 'running'}
						<Loader2 size={11} class="text-white animate-spin" />
					{:else}
						<Circle size={6} class="fill-white text-white" />
					{/if}
				</div>

				<!-- Bottom connector line -->
				{#if !isLast}
					<div class="absolute top-[calc(0.5rem+1.25rem)] bottom-0 w-px bg-border"></div>
				{/if}
			</div>

			<!-- Step content -->
			<div class="min-w-0 flex-1 pb-2">
				<button
					class="group flex w-full items-center gap-2 rounded-lg py-1.5 text-left hover:bg-muted/50 transition-colors"
					onclick={() => toggleStep(i)}
				>
					<svelte:component this={isExpanded ? ChevronDown : ChevronRight} size={12} class="shrink-0 text-muted-foreground" />
					<span class="flex-1 truncate text-xs font-medium group-hover:text-foreground">
						{step.displayLabel || step.label || step.stepName}
					</span>
					{#if step.durationMs !== null}
						<span class="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
							{formatDuration(step.durationMs)}
						</span>
					{/if}
				</button>

				{#if isExpanded}
					<div class="mt-1.5 mb-1 space-y-2.5 pl-5">
						{#if step.input}
							<CollapsibleSection
								title="Input"
								defaultOpen={false}
								copyData={JSON.stringify(step.input, null, 2)}
							>
								<JsonViewer data={step.input} label="Input" collapsed={false} />
							</CollapsibleSection>
						{/if}

						{#if step.output}
							<CollapsibleSection
								title="Output"
								defaultOpen={false}
								copyData={JSON.stringify(step.output, null, 2)}
							>
								<JsonViewer data={step.output} label="Output" collapsed={false} />
							</CollapsibleSection>
						{/if}

						{#if step.error}
							<CollapsibleSection title="Error" defaultOpen={true} isError>
								<div class="rounded-md border border-red-500/20 bg-red-500/5 p-2">
									<pre class="max-h-[30vh] overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-red-500">{step.error}</pre>
								</div>
							</CollapsibleSection>
						{/if}

						{#if !step.input && !step.output && !step.error}
							<div class="rounded-md border bg-muted/30 py-2.5 text-center text-[10px] text-muted-foreground">
								No data recorded
							</div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/each}
</div>

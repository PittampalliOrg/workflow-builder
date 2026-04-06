<script lang="ts">
	import { getContext } from 'svelte';
	import { Loader2, Check, X, Play, Square, RotateCcw, Sparkles } from 'lucide-svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import type { createBuildWorkflowStore } from '$lib/stores/build-workflow.svelte';

	const build = getContext<ReturnType<typeof createBuildWorkflowStore>>('build-workflow');

	let phaseLabel = $derived.by(() => {
		switch (build.phase) {
			case 'idle': return 'Ready';
			case 'loading': return 'Loading context...';
			case 'generating': return 'Generating spec...';
			case 'parsing': return 'Parsing spec...';
			case 'saving': return 'Saving workflow...';
			case 'executing': return 'Starting execution...';
			case 'running': return 'Executing workflow...';
			case 'fixing': return 'Fixing errors...';
			case 'complete': return 'Complete!';
			case 'failed': return 'Failed';
			case 'error': return 'Error';
			default: return build.phase;
		}
	});

	let isActive = $derived(build.phase !== 'idle' && build.phase !== 'complete' && build.phase !== 'failed' && build.phase !== 'error');
</script>

<div class="flex flex-col gap-3 p-3">
	<!-- Header -->
	<div class="flex items-center justify-between">
		<div class="flex items-center gap-2">
			<Sparkles size={14} class="text-amber-500" />
			<span class="text-xs font-medium">Workflow Builder Agent</span>
		</div>
		{#if build.attempt > 0}
			<Badge variant="outline" class="text-[9px]">
				Attempt {build.attempt}/{build.maxAttempts}
			</Badge>
		{/if}
	</div>

	<!-- Status -->
	<div class="flex items-center gap-2 rounded-lg bg-muted px-3 py-2">
		{#if isActive}
			<Loader2 size={12} class="animate-spin text-amber-500" />
		{:else if build.phase === 'complete'}
			<Check size={12} class="text-green-500" />
		{:else if build.phase === 'failed' || build.phase === 'error'}
			<X size={12} class="text-red-500" />
		{/if}
		<span class="text-xs">{phaseLabel}</span>
	</div>

	{#if build.message && build.message !== phaseLabel}
		<p class="text-[10px] text-muted-foreground">{build.message}</p>
	{/if}

	<!-- Step Results -->
	{#if build.steps.length > 0}
		<div class="space-y-1">
			<span class="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Steps</span>
			{#each build.steps as step}
				<div class="flex items-center gap-1.5 text-[10px]">
					{#if step.status === 'success'}
						<Check size={10} class="text-green-500" />
					{:else if step.status === 'error'}
						<X size={10} class="text-red-500" />
					{:else}
						<Loader2 size={10} class="animate-spin text-muted-foreground" />
					{/if}
					<span class="truncate">{step.name}</span>
					{#if step.durationMs}
						<span class="text-muted-foreground ml-auto">{step.durationMs}ms</span>
					{/if}
				</div>
				{#if step.error}
					<p class="text-[9px] text-destructive ml-4 truncate">{step.error}</p>
				{/if}
			{/each}
		</div>
	{/if}

	<!-- Spec Preview -->
	{#if build.currentSpecYaml}
		<details class="text-[10px]">
			<summary class="cursor-pointer text-muted-foreground hover:text-foreground">
				Show generated spec
			</summary>
			<pre class="mt-1 max-h-[200px] overflow-auto rounded bg-muted p-2 text-[9px] font-mono">{build.currentSpecYaml}</pre>
		</details>
	{/if}

	<!-- Actions -->
	<div class="flex gap-1.5">
		{#if build.isRunning}
			<Button variant="outline" size="sm" class="h-6 text-[10px] gap-1" onclick={() => build.stop()}>
				<Square size={10} />
				Stop
			</Button>
		{:else if build.phase === 'complete' || build.phase === 'failed' || build.phase === 'error'}
			<Button variant="outline" size="sm" class="h-6 text-[10px] gap-1" onclick={() => build.reset()}>
				<RotateCcw size={10} />
				Reset
			</Button>
		{/if}
	</div>

	<!-- Log -->
	{#if build.log.length > 0}
		<details class="text-[10px]">
			<summary class="cursor-pointer text-muted-foreground hover:text-foreground">
				Build log ({build.log.length} events)
			</summary>
			<div class="mt-1 max-h-[150px] overflow-auto space-y-0.5">
				{#each build.log as entry}
					<div class="text-[8px] text-muted-foreground font-mono">
						{new Date(entry.timestamp).toLocaleTimeString()} [{entry.type}] {JSON.stringify(entry.data).slice(0, 80)}
					</div>
				{/each}
			</div>
		</details>
	{/if}
</div>

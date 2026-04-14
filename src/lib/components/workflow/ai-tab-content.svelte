<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import { Info, ChevronDown, ChevronRight, Plug, Zap, Trash2 } from 'lucide-svelte';
	import { buttonVariants } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import type { createAiAssistantStore } from '$lib/stores/ai-assistant.svelte';
	import type { createBuildWorkflowStore } from '$lib/stores/build-workflow.svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import AiChatMessages from '$lib/components/ai-assistant/ai-chat-messages.svelte';
	import AiChatInput from '$lib/components/ai-assistant/ai-chat-input.svelte';
	import BuildWorkflowPanel from '$lib/components/ai-assistant/build-workflow-panel.svelte';

	const assistant = getContext<ReturnType<typeof createAiAssistantStore>>('ai-assistant');
	const buildAgent = getContext<ReturnType<typeof createBuildWorkflowStore>>('build-workflow');
	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	let showBuildPanel = $derived(buildAgent.phase !== 'idle');

	// AI context indicator — shows what the LLM has access to
	let contextExpanded = $state(false);
	let connections = $state<Array<{ pieceName: string; displayName: string }>>([]);
	let actionCount = $state(0);

	onMount(async () => {
		try {
			const [connRes, catalogRes] = await Promise.all([
				fetch('/api/app-connections').then(r => r.json()).catch(() => []),
				fetch('/api/action-catalog').then(r => r.json()).catch(() => ({ items: [] })),
			]);
			const conns = Array.isArray(connRes) ? connRes : connRes.connections || [];
			connections = conns
				.filter((c: Record<string, unknown>) => c.status === 'ACTIVE')
				.map((c: Record<string, unknown>) => ({
					pieceName: ((c.pieceName as string) || '').replace('@activepieces/piece-', ''),
					displayName: (c.displayName || c.pieceName) as string,
				}));
			actionCount = ((catalogRes.items || []) as Array<Record<string, unknown>>).filter(i => i.insertable).length;
		} catch { /* silent */ }
	});

	const specTaskCount = $derived.by(() => {
		if (!store.spec) return 0;
		const doArray = (store.spec as Record<string, unknown>).do;
		return Array.isArray(doArray) ? doArray.length : 0;
	});

	const selectedTaskName = $derived(assistant.workflowContext?.selectedTaskName);
</script>

<div class="flex flex-1 flex-col overflow-hidden">
	{#if showBuildPanel}
		<BuildWorkflowPanel />
	{/if}

	<!-- Context bar + clear chat -->
	<div class="flex items-center border-b border-border">
		<button
			class="flex flex-1 items-center gap-1.5 px-3 py-1.5 text-[10px] text-muted-foreground hover:bg-accent/30 transition-colors"
			onclick={() => contextExpanded = !contextExpanded}
		>
			<Info size={10} class="shrink-0" />
			<span class="flex-1 text-left">
				AI context: {connections.length} connection{connections.length !== 1 ? 's' : ''}, {actionCount} actions, {specTaskCount} task{specTaskCount !== 1 ? 's' : ''}
				{#if selectedTaskName}
					, selected {selectedTaskName}
				{/if}
			</span>
			{#if contextExpanded}
				<ChevronDown size={10} />
			{:else}
				<ChevronRight size={10} />
			{/if}
		</button>

		{#if assistant.messages.length > 0}
			<Tooltip.Root>
				<Tooltip.Trigger
					class={`${buttonVariants({ variant: 'ghost', size: 'icon-xs' })} mr-1 text-muted-foreground hover:text-destructive`}
					onclick={() => assistant.clearHistory()}
				>
					<Trash2 size={10} />
				</Tooltip.Trigger>
				<Tooltip.Content>Clear chat</Tooltip.Content>
			</Tooltip.Root>
		{/if}
	</div>

	{#if contextExpanded}
		<div class="border-b border-border bg-accent/10 px-3 py-2 text-[10px] text-muted-foreground space-y-1.5">
			{#if connections.length > 0}
				<div class="flex items-center gap-1">
					<Plug size={10} />
					<span class="font-medium">Connections:</span>
				</div>
				<div class="flex flex-wrap gap-1 ml-3.5">
					{#each connections as conn}
						<span class="rounded bg-accent/50 px-1.5 py-0.5">{conn.displayName}</span>
					{/each}
				</div>
			{:else}
				<div class="flex items-center gap-1">
					<Plug size={10} />
					<span>No connections configured — <a href="/connections" class="underline">add one</a></span>
				</div>
			{/if}

			<div class="flex items-center gap-1">
				<Zap size={10} />
				<span>{actionCount} actions available ({connections.length} connected providers with full schemas)</span>
			</div>

			{#if specTaskCount > 0}
				<div class="text-[9px] text-muted-foreground/70">
					Current spec has {specTaskCount} task{specTaskCount !== 1 ? 's' : ''} — AI will modify existing workflow
				</div>
			{:else}
				<div class="text-[9px] text-muted-foreground/70">
					No tasks yet — AI will create a new workflow
				</div>
			{/if}

			{#if selectedTaskName}
				<div class="text-[9px] text-muted-foreground/70">
					Selected node requests will target <code>{selectedTaskName}</code>
				</div>
			{/if}
		</div>
	{/if}

	<AiChatMessages />
	<AiChatInput />
</div>

<script lang="ts">
	import { Play } from '@lucide/svelte';
	import { getContext, onMount, onDestroy } from 'svelte';
	import BaseSWNode from '../base-sw-node.svelte';
	import type { PortConfig } from '$lib/types/workflow-handles';
	import type { createUiStore } from '$lib/stores/ui.svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';

	interface Props {
		data: Record<string, unknown>;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const ports: PortConfig[] = [
		{ id: 'source', type: 'source', position: 'bottom', rule: { dataType: 'control' } }
	];

	// The start node is the workflow's entry point — surface HOW it's triggered
	// (the workflow_triggers configured via the Triggers panel) right on the
	// canvas, and let a click jump straight to that panel. Triggers are a
	// lifecycle resource (multi-per-workflow, activatable), so the node is the
	// visual handle + the panel stays the editor.
	const ui = getContext<ReturnType<typeof createUiStore>>('ui');
	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	type TriggerSummary = { kind: string; status: string };
	let triggers = $state<TriggerSummary[]>([]);
	let loaded = $state(false);

	async function loadTriggers() {
		const wfId = store?.workflowId;
		if (!wfId) {
			loaded = true;
			return;
		}
		try {
			const res = await fetch(`/api/workflows/${encodeURIComponent(wfId)}/triggers`);
			if (res.ok) {
				const body = (await res.json()) as { triggers?: TriggerSummary[] };
				triggers = body.triggers ?? [];
			}
		} catch {
			// best-effort badge — leave as-is on failure
		} finally {
			loaded = true;
		}
	}

	let timer: ReturnType<typeof setInterval> | undefined;
	onMount(() => {
		loadTriggers();
		// light refresh so add/activate from the panel reflects on the node
		timer = setInterval(loadTriggers, 8000);
	});
	onDestroy(() => clearInterval(timer));

	const anyActive = $derived(triggers.some((t) => t.status === 'active'));
	const anyError = $derived(triggers.some((t) => t.status === 'error'));
	const labelFor = (k: string) => k.charAt(0).toUpperCase() + k.slice(1);

	function openTriggers(e: MouseEvent) {
		e.stopPropagation();
		ui?.openRightPanel('triggers');
	}
</script>

<BaseSWNode {data} {selected} {ports} icon={Play} iconColor="bg-blue-500/15 text-blue-500">
	{#snippet children()}
		{#if loaded}
			<button
				type="button"
				onclick={openTriggers}
				title="Configure triggers"
				class="absolute bottom-1.5 left-1/2 z-20 flex max-w-[136px] -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-card/90 px-2 py-0.5 text-[9px] shadow-sm hover:bg-muted"
			>
				{#if triggers.length === 0}
					<span class="text-muted-foreground">Manual · add trigger</span>
				{:else}
					<span
						class="size-1.5 shrink-0 rounded-full {anyError
							? 'bg-red-500'
							: anyActive
								? 'bg-emerald-500'
								: 'bg-muted-foreground/50'}"
					></span>
					<span class="truncate font-medium text-card-foreground">
						{labelFor(triggers[0].kind)}{triggers.length > 1 ? ` +${triggers.length - 1}` : ''}
					</span>
				{/if}
			</button>
		{/if}
	{/snippet}
</BaseSWNode>

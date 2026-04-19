<script lang="ts">
	import { onMount } from 'svelte';
	import Bot from '@lucide/svelte/icons/bot';
	import BaseSWNode from '../base-sw-node.svelte';
	import type { PortConfig } from '$lib/types/workflow-handles';
	import { getAgentTaskBody, summarizeAgentGraph } from '$lib/types/agent-graph';
	import {
		agentSummaryStore,
		ensureAgentSummaries
	} from '$lib/stores/agent-summary.svelte';

	interface Props {
		data: Record<string, unknown>;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();
	const agents = agentSummaryStore();

	onMount(() => {
		void ensureAgentSummaries();
	});

	const ports: PortConfig[] = [
		{ id: 'target', type: 'target', position: 'top', rule: { dataType: 'control' } },
		{ id: 'source', type: 'source', position: 'bottom', rule: { dataType: 'control' } }
	];

	let subtitle = $derived.by(() => {
		const taskConfig = (data.taskConfig as Record<string, unknown>) || {};
		const body = getAgentTaskBody(taskConfig);
		let agentRefLabel: string;
		if (!body.agentRef) {
			agentRefLabel = 'unbound';
		} else {
			const hit = agents.map.get(body.agentRef.id);
			agentRefLabel = hit ? `agent: ${hit.name}` : `agent:${body.agentRef.id.slice(0, 8)}`;
		}
		const turnBudget =
			typeof body.maxTurns === 'number' && Number.isFinite(body.maxTurns) && body.maxTurns > 0
				? `max ${body.maxTurns} turns`
				: '';
		const graphSummary = summarizeAgentGraph(body.agentGraph);
		return [agentRefLabel, graphSummary, turnBudget].filter(Boolean).join(' • ');
	});

	let nodeData = $derived(subtitle ? { ...data, description: subtitle } : data);
</script>

<BaseSWNode
	data={nodeData}
	{selected}
	{ports}
	icon={Bot}
	iconColor="bg-cyan-500/15 text-cyan-400"
/>

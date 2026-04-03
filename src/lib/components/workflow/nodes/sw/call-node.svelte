<script lang="ts">
	import { Globe } from 'lucide-svelte';
	import BaseSWNode from '../base-sw-node.svelte';
	import type { PortConfig } from '$lib/types/workflow-handles';

	interface Props {
		data: Record<string, unknown>;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const ports: PortConfig[] = [
		{ id: 'target', type: 'target', position: 'top', rule: { dataType: 'control' } },
		{ id: 'source', type: 'source', position: 'bottom', rule: { dataType: 'control' } }
	];

	let subtitle = $derived.by(() => {
		const config = data.taskConfig as Record<string, unknown> | undefined;
		if (config?.call) return String(config.call);
		return '';
	});

	// Merge subtitle into data for BaseSWNode description display
	let nodeData = $derived(subtitle ? { ...data, description: subtitle } : data);
</script>

<BaseSWNode data={nodeData} {selected} {ports} icon={Globe} iconColor="bg-amber-500/15 text-amber-400" />

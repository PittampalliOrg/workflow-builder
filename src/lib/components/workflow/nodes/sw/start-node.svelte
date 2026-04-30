<script lang="ts">
	import { Play } from '@lucide/svelte';
	import BaseSWNode from '../base-sw-node.svelte';
	import type { PortConfig } from '$lib/types/workflow-handles';

	interface Props {
		data: Record<string, unknown>;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	const ports: PortConfig[] = [
		{ id: 'source', type: 'source', position: 'bottom', rule: { dataType: 'control' } }
	];
</script>

<BaseSWNode {data} {selected} {ports} icon={Play} iconColor="bg-blue-500/15 text-blue-500" />

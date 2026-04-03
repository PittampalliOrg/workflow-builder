<script lang="ts">
	import { Clock } from 'lucide-svelte';
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
</script>

<BaseSWNode {data} {selected} {ports} icon={Clock} iconColor="bg-sky-500/15 text-sky-400" />

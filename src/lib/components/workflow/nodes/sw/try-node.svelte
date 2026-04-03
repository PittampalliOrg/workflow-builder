<script lang="ts">
	import { Shield } from 'lucide-svelte';
	import BaseSWNode from '../base-sw-node.svelte';
	import type { PortConfig } from '$lib/types/workflow-handles';

	interface Props {
		data: Record<string, unknown>;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	// success (35%) + catch (65%) named source handles
	const ports: PortConfig[] = [
		{ id: 'target', type: 'target', position: 'top', rule: { dataType: 'control' } },
		{
			id: 'success',
			type: 'source',
			position: 'bottom',
			label: 'success',
			rule: { label: 'success', dataType: 'branch' }
		},
		{
			id: 'catch',
			type: 'source',
			position: 'bottom',
			label: 'catch',
			rule: { label: 'catch', dataType: 'branch' }
		}
	];
</script>

<BaseSWNode {data} {selected} {ports} icon={Shield} iconColor="bg-yellow-500/15 text-yellow-400" />

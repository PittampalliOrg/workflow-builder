<script lang="ts">
	import { GitBranch } from '@lucide/svelte';
	import BaseSWNode from '../base-sw-node.svelte';
	import type { PortConfig } from '$lib/types/workflow-handles';

	interface Props {
		data: Record<string, unknown>;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	// Build dynamic ports from taskConfig.cases + always-present "default"
	let ports = $derived.by(() => {
		const result: PortConfig[] = [
			{ id: 'target', type: 'target', position: 'top', rule: { dataType: 'control' } }
		];

		const config = data.taskConfig as Record<string, unknown> | undefined;
		const cases = config?.cases as Record<string, unknown>[] | undefined;

		if (Array.isArray(cases) && cases.length > 0) {
			for (const c of cases) {
				const name = (c as Record<string, unknown>).name as string;
				if (name) {
					result.push({
						id: name,
						type: 'source',
						position: 'bottom',
						label: name,
						rule: { label: name, dataType: 'branch' }
					});
				}
			}
		}

		// Always add a default source
		result.push({
			id: 'default',
			type: 'source',
			position: 'bottom',
			label: 'default',
			rule: { label: 'default', dataType: 'branch' }
		});

		return result;
	});
</script>

<BaseSWNode {data} {selected} {ports} icon={GitBranch} iconColor="bg-pink-500/15 text-pink-400" />

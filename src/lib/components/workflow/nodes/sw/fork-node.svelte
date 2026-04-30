<script lang="ts">
	import { GitFork } from '@lucide/svelte';
	import BaseSWNode from '../base-sw-node.svelte';
	import type { PortConfig } from '$lib/types/workflow-handles';

	interface Props {
		data: Record<string, unknown>;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	// Build dynamic branch ports from taskConfig.fork.branches
	let ports = $derived.by(() => {
		const result: PortConfig[] = [
			{ id: 'target', type: 'target', position: 'top', rule: { dataType: 'control' } }
		];

		const config = data.taskConfig as Record<string, unknown> | undefined;
		const fork = config?.fork as Record<string, unknown> | undefined;
		const branches = fork?.branches as Record<string, unknown>[] | undefined;

		if (Array.isArray(branches) && branches.length > 0) {
			for (const b of branches) {
				const name = (b as Record<string, unknown>).name as string;
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
		} else {
			// Fallback: single source handle
			result.push({
				id: 'source',
				type: 'source',
				position: 'bottom',
				rule: { dataType: 'control' }
			});
		}

		return result;
	});
</script>

<BaseSWNode {data} {selected} {ports} icon={GitFork} iconColor="bg-indigo-500/15 text-indigo-400" />

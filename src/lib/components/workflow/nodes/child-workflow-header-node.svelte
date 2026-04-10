<script lang="ts">
	import { Boxes } from 'lucide-svelte';
	import type { WorkflowNodeData } from '$lib/stores/workflow.svelte';

	interface Props {
		data: WorkflowNodeData;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();

	let statusClass = $derived(
		data.status === 'running'
			? 'border-cyan-500'
			: data.status === 'success'
				? 'border-emerald-500'
				: data.status === 'error'
					? 'border-rose-500'
					: 'border-sky-400/70 dark:border-sky-700/70'
	);
</script>

<div
	class="rounded-2xl border-2 bg-gradient-to-r from-sky-100 via-white to-cyan-50 px-4 py-3 shadow-xl transition-colors dark:from-sky-950/70 dark:via-slate-950 dark:to-cyan-950/50 {statusClass} {selected ? 'ring-2 ring-sky-400/60' : ''}"
>
	<div class="flex items-center gap-3">
		<div class="rounded-xl border border-sky-300/70 bg-white/90 p-2 text-sky-700 shadow-sm dark:border-sky-700/70 dark:bg-slate-950/70 dark:text-sky-200">
			<Boxes size={16} />
		</div>
		<div class="min-w-0">
			<div class="mb-1 flex items-center gap-2">
				<span class="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-sky-700 dark:text-sky-200">
					Child Workflow
				</span>
			</div>
			<div class="truncate text-sm font-semibold text-slate-900 dark:text-slate-50">{data.description ?? data.label}</div>
		</div>
	</div>
</div>

<script lang="ts">
	import { Handle, Position } from '@xyflow/svelte';
	import { Circle, Boxes, Sparkles } from '@lucide/svelte';
	import type { WorkflowNodeData } from '$lib/stores/workflow.svelte';

	interface Props {
		data: WorkflowNodeData;
		selected?: boolean;
	}

	let { data, selected = false }: Props = $props();
	const isChildWorkflow = $derived(Boolean(data.childWorkflow));
	const childWorkflowRole = $derived(
		typeof data.childWorkflowRole === 'string' ? data.childWorkflowRole : null
	);

	let statusColor = $derived(
		data.status === 'running'
			? 'border-yellow-500'
			: data.status === 'success'
				? 'border-green-500'
				: data.status === 'error'
					? 'border-red-500'
					: 'border-border'
	);
	let wrapperClass = $derived(
		isChildWorkflow
			? childWorkflowRole === 'header'
				? 'bg-primary/10 border-primary/40 shadow-md'
				: 'bg-primary/[0.06] border-primary/25'
			: 'bg-card'
	);
	let iconWrapClass = $derived(
		isChildWorkflow ? 'bg-primary/15 border border-primary/20' : 'bg-gray-100 dark:bg-gray-800'
	);
	let iconClass = $derived(
		isChildWorkflow
			? 'text-primary'
			: 'text-gray-600 dark:text-gray-400'
	);
	let sandboxMode = $derived.by(() => {
		const taskConfig = data.taskConfig;
		if (!taskConfig || typeof taskConfig !== 'object' || Array.isArray(taskConfig)) return null;
		const withBlock = (taskConfig as Record<string, unknown>).with;
		if (!withBlock || typeof withBlock !== 'object' || Array.isArray(withBlock)) return null;
		const body = (withBlock as Record<string, unknown>).body as
			| Record<string, unknown>
			| undefined;
		const envRef = body?.environmentRef ?? (withBlock as Record<string, unknown>).environmentRef;
		if (envRef && typeof envRef === 'object') {
			return 'env';
		}
		const agentRef = body?.agentRef ?? (withBlock as Record<string, unknown>).agentRef;
		if (agentRef && typeof agentRef === 'object') {
			return 'agent';
		}
		return null;
	});
</script>

<div
	class="rounded-lg border-2 px-4 py-3 shadow-sm transition-colors {wrapperClass} {statusColor} {selected
		? 'ring-2 ring-ring'
		: ''}"
>
	<Handle type="target" position={Position.Top} />

	<div class="flex items-center gap-2">
		<div class="rounded-md p-1.5 {iconWrapClass}">
			{#if isChildWorkflow}
				{#if childWorkflowRole === 'header'}
					<Boxes size={14} class={iconClass} />
				{:else}
					<Sparkles size={14} class={iconClass} />
				{/if}
			{:else}
				<Circle size={14} class={iconClass} />
			{/if}
		</div>
		<div class="min-w-0">
			<div class="flex items-center gap-2">
				<div class="truncate text-xs font-medium text-card-foreground">{data.label}</div>
				{#if isChildWorkflow}
					<span class="rounded-full bg-primary/12 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-primary">
						child
					</span>
				{/if}
				{#if sandboxMode}
					<span class="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 dark:text-emerald-300">
						{sandboxMode}
					</span>
				{/if}
			</div>
			{#if data.description}
				<div class="truncate text-xs text-muted-foreground">{data.description}</div>
			{/if}
		</div>
	</div>

	<Handle type="source" position={Position.Bottom} />
</div>

<script lang="ts">
	import { getContext } from 'svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Separator } from '$lib/components/ui/separator';
	import { Badge } from '$lib/components/ui/badge';
	import SwCallConfig from './config/sw-call-config.svelte';
	import SwAgentConfig from './config/sw-agent-config.svelte';
	import SwSetConfig from './config/sw-set-config.svelte';
	import SwSwitchConfig from './config/sw-switch-config.svelte';
	import SwEmitConfig from './config/sw-emit-config.svelte';
	import SwWaitConfig from './config/sw-wait-config.svelte';
	import SwRunConfig from './config/sw-run-config.svelte';
	import SwGenericConfig from './config/sw-generic-config.svelte';
	import JsonViewer from './execution/json-viewer.svelte';
	import { updateTask as specUpdateTask } from '$lib/helpers/spec-mutations';
	import { getTaskNameFromNodeId } from '$lib/helpers/workflow-action-spec';
	import { compileSandboxPolicies } from '$lib/workflows/sandbox-policy';

	interface Props {
		mode?: 'properties' | 'code' | 'all';
	}

	let { mode = 'all' }: Props = $props();

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	function handleConfigUpdate(key: string, value: unknown) {
		if (store.selectedNodeId) {
			if (key === 'taskConfig' && store.spec && value && typeof value === 'object' && !Array.isArray(value)) {
				const taskName = getTaskNameFromNodeId(store.selectedNodeId);
				if (taskName) {
					store.spec = compileSandboxPolicies(
						specUpdateTask(store.spec, taskName, value as Record<string, unknown>)
					);
					store.isDirty = true;
				}
			}
			store.updateNodeData(store.selectedNodeId, { [key]: value });
		}
	}

	const configComponents: Record<string, typeof SwCallConfig> = {
		call: SwCallConfig,
		agent: SwAgentConfig,
		set: SwSetConfig,
		switch: SwSwitchConfig,
		emit: SwEmitConfig,
		wait: SwWaitConfig,
		run: SwRunConfig
	};

	const genericTypes = new Set(['for', 'fork', 'try', 'raise', 'do', 'listen', 'start', 'end']);

	let nodeType = $derived(store.selectedNode?.type || store.selectedNode?.data?.type || 'unknown');

	let statusVariant = $derived.by(() => {
		const s = (store.selectedNode?.data?.status as string)?.toLowerCase();
		if (s === 'success' || s === 'completed') return 'default' as const;
		if (s === 'error' || s === 'failed') return 'destructive' as const;
		if (s === 'running') return 'secondary' as const;
		return 'outline' as const;
	});
</script>

{#if store.selectedNode}
	<div class="p-3 space-y-3">
		{#if mode === 'properties' || mode === 'all'}
			<!-- Node identity -->
			<div class="flex items-center gap-2">
				<Badge variant="outline" class="text-[10px] font-mono">{nodeType}</Badge>
				{#if store.selectedNode.data.status}
					<Badge variant={statusVariant} class="text-[10px] capitalize">
						{store.selectedNode.data.status}
					</Badge>
				{/if}
			</div>

			<!-- Editable fields -->
			<div class="space-y-3">
				<div class="space-y-1">
					<Label for="node-label" class="text-[11px]">Label</Label>
					<Input
						id="node-label"
						class="h-7 text-xs"
						value={store.selectedNode.data.label}
						oninput={(e) => {
							if (store.selectedNodeId) {
								store.updateNodeData(store.selectedNodeId, {
									label: e.currentTarget.value
								});
							}
						}}
					/>
				</div>
				<div class="space-y-1">
					<Label for="node-desc" class="text-[11px]">Description</Label>
					<Textarea
						id="node-desc"
						class="min-h-[52px] text-xs"
						value={store.selectedNode.data.description || ''}
						oninput={(e) => {
							if (store.selectedNodeId) {
								store.updateNodeData(store.selectedNodeId, {
									description: e.currentTarget.value
								});
							}
						}}
						rows={2}
					/>
				</div>
			</div>

			<!-- Type-specific config section -->
			<Separator />
			<div>
				<h4 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
					{nodeType} Configuration
				</h4>
				{#if configComponents[nodeType]}
					{@const ConfigComponent = configComponents[nodeType]}
					<ConfigComponent
						data={store.selectedNode.data}
						onUpdate={handleConfigUpdate}
					/>
				{:else if genericTypes.has(nodeType)}
					<SwGenericConfig
						data={store.selectedNode.data}
						onUpdate={handleConfigUpdate}
					/>
				{:else}
					<p class="text-[11px] text-muted-foreground italic">
						No configuration available for this node type.
					</p>
				{/if}
			</div>
		{/if}

		{#if mode === 'code' || mode === 'all'}
			{#if mode === 'all'}
				<Separator />
				<h4 class="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
					Code
				</h4>
			{/if}
			<JsonViewer
				data={store.selectedNode.data.taskConfig || store.selectedNode.data.config || {}}
				label="Node Configuration"
				collapsed={false}
			/>
		{/if}
	</div>
{/if}

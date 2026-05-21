<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { NativeSelect } from '$lib/components/ui/native-select';
	import { Badge } from '$lib/components/ui/badge';
	import { RefreshCw } from '@lucide/svelte';
	import type {
		ServiceGraphMode,
		ServiceGraphScope,
		ServiceGraphWindow
	} from '$lib/types/service-graph';

	type ExecOption = { id: string; label: string };
	type WorkflowOption = { id: string; name: string };

	let {
		mode = $bindable<ServiceGraphMode>('service'),
		scope = $bindable<ServiceGraphScope>('execution'),
		executionId = $bindable<string>(''),
		workflowId = $bindable<string>(''),
		windowKey = $bindable<ServiceGraphWindow>('1h'),
		executions = [],
		workflows = [],
		loading = false,
		onrefresh
	}: {
		mode?: ServiceGraphMode;
		scope?: ServiceGraphScope;
		executionId?: string;
		workflowId?: string;
		windowKey?: ServiceGraphWindow;
		executions?: ExecOption[];
		workflows?: WorkflowOption[];
		loading?: boolean;
		onrefresh?: () => void;
	} = $props();

	const WINDOWS: ServiceGraphWindow[] = ['5m', '15m', '1h', '6h', '24h'];

	// step + window requires a workflow; nudge selection if missing.
	let stepWindowNeedsWorkflow = $derived(mode === 'step' && scope === 'window' && !workflowId);
</script>

<div class="flex flex-wrap items-end gap-3 border-b bg-card px-4 py-3">
	<!-- Node model -->
	<div class="flex flex-col gap-1">
		<span class="text-xs font-medium text-muted-foreground">Nodes</span>
		<div class="inline-flex overflow-hidden rounded-md border">
			<Button
				variant={mode === 'service' ? 'default' : 'ghost'}
				size="sm"
				class="rounded-none"
				onclick={() => (mode = 'service')}>Services</Button
			>
			<Button
				variant={mode === 'step' ? 'default' : 'ghost'}
				size="sm"
				class="rounded-none"
				onclick={() => (mode = 'step')}>Workflow steps</Button
			>
		</div>
	</div>

	<!-- Scope -->
	<div class="flex flex-col gap-1">
		<span class="text-xs font-medium text-muted-foreground">Scope</span>
		<div class="inline-flex overflow-hidden rounded-md border">
			<Button
				variant={scope === 'execution' ? 'default' : 'ghost'}
				size="sm"
				class="rounded-none"
				onclick={() => (scope = 'execution')}>This run</Button
			>
			<Button
				variant={scope === 'window' ? 'default' : 'ghost'}
				size="sm"
				class="rounded-none"
				onclick={() => (scope = 'window')}>Time window</Button
			>
		</div>
	</div>

	{#if scope === 'execution'}
		<div class="flex min-w-56 flex-col gap-1">
			<span class="text-xs font-medium text-muted-foreground">Execution</span>
			<NativeSelect bind:value={executionId} class="w-full">
				<option value="" disabled>Select a run…</option>
				{#each executions as ex}
					<option value={ex.id}>{ex.label}</option>
				{/each}
			</NativeSelect>
		</div>
	{:else}
		<div class="flex flex-col gap-1">
			<span class="text-xs font-medium text-muted-foreground">Window</span>
			<NativeSelect bind:value={windowKey} class="w-28">
				{#each WINDOWS as w}
					<option value={w}>last {w}</option>
				{/each}
			</NativeSelect>
		</div>
		<div class="flex min-w-52 flex-col gap-1">
			<span class="text-xs font-medium text-muted-foreground">
				Workflow {mode === 'step' ? '(required)' : '(optional)'}
			</span>
			<NativeSelect bind:value={workflowId} class="w-full">
				<option value="">{mode === 'step' ? 'Select a workflow…' : 'All workflows'}</option>
				{#each workflows as wf}
					<option value={wf.id}>{wf.name}</option>
				{/each}
			</NativeSelect>
		</div>
	{/if}

	<div class="ml-auto flex items-center gap-2">
		{#if stepWindowNeedsWorkflow}
			<Badge variant="outline" class="text-amber-600">Pick a workflow</Badge>
		{/if}
		<Button variant="outline" size="sm" disabled={loading} onclick={() => onrefresh?.()}>
			<RefreshCw size={14} class={loading ? 'animate-spin' : ''} />
			Refresh
		</Button>
	</div>
</div>

<script lang="ts">
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import { Save, Play, Undo2, Redo2, Map, ListOrdered, BookMarked, FilePlus } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { Button, buttonVariants } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Separator } from '$lib/components/ui/separator';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Badge } from '$lib/components/ui/badge';
	import PublishBadge from './publish-badge.svelte';
	import ExecuteDialog from './execute-dialog.svelte';
	import WorkflowSwitcher from './workflow-switcher.svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import type { createUiStore } from '$lib/stores/ui.svelte';

	let isPublishing = $state(false);
	let showExecuteDialog = $state(false);
	let switcherRef: WorkflowSwitcher | undefined = $state();

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const ui = getContext<ReturnType<typeof createUiStore>>('ui');

	async function saveWorkflow() {
		if (!store.workflowId) return;
		store.isSaving = true;
		try {
			await fetch(`/api/workflows/${store.workflowId}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: store.workflowName,
					nodes: store.nodes,
					edges: store.edges,
					spec: store.spec
				})
			});
			store.isDirty = false;
		} catch (err) {
			console.error('Failed to save:', err);
		} finally {
			store.isSaving = false;
		}
	}

	async function executeWorkflow(input: Record<string, unknown>) {
		if (!store.workflowId) return;
		try {
			const res = await fetch(`/api/workflows/${store.workflowId}/execute`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ input })
			});
			if (res.ok) {
				const { executionId } = await res.json();
				store.selectedExecutionId = executionId;
				ui.openRightPanel('runs');
			} else {
				const err = await res.json().catch(() => ({ message: 'Execution failed' }));
				console.error('Execute failed:', err.message);
				toast.error('Execution failed', { description: err.message });
			}
		} catch (err) {
			console.error('Failed to execute:', err);
		}
	}

	async function publishWorkflow() {
		if (!store.workflowId || store.isDirty) return;
		isPublishing = true;
		try {
			const res = await fetch(`/api/workflows/${store.workflowId}/publish`, { method: 'POST' });
			if (res.ok) {
				const data = await res.json();
				store.publishedRuntime = data.publishedRuntime || data.spec?.metadata?.publishedRuntime || null;
			}
		} catch (err) {
			console.error('Failed to publish:', err);
		} finally {
			isPublishing = false;
		}
	}

	async function handleNewWorkflow() {
		if (store.isDirty) {
			if (!confirm('You have unsaved changes. Create new workflow anyway?')) return;
		}
		try {
			const res = await fetch('/api/workflows', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: 'Untitled Workflow',
					nodes: [
						{ id: '__start__', type: 'start', position: { x: 250, y: 50 }, data: { label: 'Start', status: 'idle', taskType: 'start' } },
						{ id: '__end__', type: 'end', position: { x: 250, y: 300 }, data: { label: 'End', status: 'idle', taskType: 'end' } }
					],
					edges: [{ id: '__start__->__end__', source: '__start__', target: '__end__' }]
				})
			});
			if (res.ok) {
				const workflow = await res.json();
				goto(`/workflows/${workflow.id}`);
			}
		} catch (err) {
			console.error('Failed to create workflow:', err);
			toast.error('Failed to create workflow');
		}
	}

	function onKeyDown(event: KeyboardEvent) {
		const mod = event.metaKey || event.ctrlKey;
		if (mod && event.key === 's') {
			event.preventDefault();
			saveWorkflow();
		}
		if (mod && event.key === 'p') {
			event.preventDefault();
			switcherRef?.toggle();
		}
	}
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="flex h-10 items-center justify-between border-b border-border bg-card px-2">
	<!-- Left: new + workflow name container -->
	<div class="flex items-center gap-2">
		<Tooltip.Root>
			<Tooltip.Trigger
				class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
				onclick={handleNewWorkflow}
			>
				<FilePlus size={14} />
			</Tooltip.Trigger>
			<Tooltip.Content>New workflow</Tooltip.Content>
		</Tooltip.Root>
		<WorkflowSwitcher bind:this={switcherRef} />
		<PublishBadge publishedRuntime={store.publishedRuntime} />
		{#if store.isDirty}
			<Badge variant="outline" class="text-[9px] px-1.5 py-0 text-muted-foreground">Unsaved</Badge>
		{/if}
	</div>

	<div class="flex items-center gap-1">
		<Tooltip.Root>
			<Tooltip.Trigger
				class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
				onclick={() => store.undo()}
				disabled={!store.canUndo}
			>
				<Undo2 size={14} />
			</Tooltip.Trigger>
			<Tooltip.Content>Undo (Ctrl+Z)</Tooltip.Content>
		</Tooltip.Root>
		<Tooltip.Root>
			<Tooltip.Trigger
				class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
				onclick={() => store.redo()}
				disabled={!store.canRedo}
			>
				<Redo2 size={14} />
			</Tooltip.Trigger>
			<Tooltip.Content>Redo (Ctrl+Shift+Z)</Tooltip.Content>
		</Tooltip.Root>

		<Separator orientation="vertical" class="mx-1 h-3.5" />

		<Tooltip.Root>
			<Tooltip.Trigger
				class={`${buttonVariants({ variant: 'ghost', size: 'icon-sm' })} ${store.showMinimap ? 'bg-accent text-accent-foreground' : ''}`}
				onclick={() => (store.showMinimap = !store.showMinimap)}
			>
				<Map size={14} />
			</Tooltip.Trigger>
			<Tooltip.Content>Toggle minimap</Tooltip.Content>
		</Tooltip.Root>
		<Tooltip.Root>
			<Tooltip.Trigger
				class={`${buttonVariants({ variant: 'ghost', size: 'icon-sm' })} ${ui.rightPanelOpen && ui.rightPanelTab === 'runs' ? 'bg-accent text-accent-foreground' : ''}`}
				onclick={() => ui.toggleRightPanel('runs')}
			>
				<ListOrdered size={14} />
			</Tooltip.Trigger>
			<Tooltip.Content>Toggle runs panel</Tooltip.Content>
		</Tooltip.Root>

		<Separator orientation="vertical" class="mx-1 h-3.5" />

		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1 px-2 text-xs"
			onclick={saveWorkflow}
			disabled={store.isSaving || !store.isDirty}
		>
			<Save size={12} />
			{store.isSaving ? 'Saving...' : 'Save'}
		</Button>

		<Button
			variant="ghost"
			size="sm"
			class="h-7 gap-1 px-2 text-xs"
			onclick={publishWorkflow}
			disabled={isPublishing || store.isDirty}
			title={store.isDirty ? 'Save before publishing' : 'Publish workflow'}
		>
			<BookMarked size={12} />
			Publish
		</Button>

		<Button
			size="sm"
			class="h-7 gap-1.5 px-3 text-xs"
			onclick={() => (showExecuteDialog = true)}
		>
			<Play size={12} />
			Execute
		</Button>
	</div>
</div>

<ExecuteDialog
	open={showExecuteDialog}
	onClose={() => (showExecuteDialog = false)}
	onExecute={executeWorkflow}
/>

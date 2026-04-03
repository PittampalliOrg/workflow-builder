<script lang="ts">
	import { getContext } from 'svelte';
	import { Save, Play, Undo2, Redo2, Map, ListOrdered, BookMarked } from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Separator } from '$lib/components/ui/separator';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { Badge } from '$lib/components/ui/badge';
	import PublishBadge from './publish-badge.svelte';
	import ExecuteDialog from './execute-dialog.svelte';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';

	let isPublishing = $state(false);
	let showExecuteDialog = $state(false);

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

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
					edges: store.edges
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
				store.showRunsPanel = true;
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

	function onKeyDown(event: KeyboardEvent) {
		if ((event.metaKey || event.ctrlKey) && event.key === 's') {
			event.preventDefault();
			saveWorkflow();
		}
	}
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="flex h-10 items-center justify-between border-b border-border bg-card px-2">
	<!-- Left: workflow name container -->
	<div class="flex items-center gap-2">
		<div class="flex items-center gap-1.5 rounded-md border border-border/50 bg-background/50 px-2.5 py-1">
			<Input
				type="text"
				bind:value={store.workflowName}
				class="h-5 w-auto min-w-[100px] max-w-[220px] border-none bg-transparent px-0 text-xs font-medium text-card-foreground shadow-none outline-none focus-visible:ring-0"
				placeholder="Workflow name"
			/>
			<PublishBadge publishedRuntime={store.publishedRuntime} />
		</div>
		{#if store.isDirty}
			<Badge variant="outline" class="text-[9px] px-1.5 py-0 text-muted-foreground">Unsaved</Badge>
		{/if}
	</div>

	<div class="flex items-center gap-1">
		<Tooltip.Root>
			<Tooltip.Trigger>
				<Button
					variant="ghost"
					size="icon"
					onclick={() => store.undo()}
					disabled={!store.canUndo}
					class="h-7 w-7"
				>
					<Undo2 size={14} />
				</Button>
			</Tooltip.Trigger>
			<Tooltip.Content>Undo (Ctrl+Z)</Tooltip.Content>
		</Tooltip.Root>
		<Tooltip.Root>
			<Tooltip.Trigger>
				<Button
					variant="ghost"
					size="icon"
					onclick={() => store.redo()}
					disabled={!store.canRedo}
					class="h-7 w-7"
				>
					<Redo2 size={14} />
				</Button>
			</Tooltip.Trigger>
			<Tooltip.Content>Redo (Ctrl+Shift+Z)</Tooltip.Content>
		</Tooltip.Root>

		<Separator orientation="vertical" class="mx-1 h-3.5" />

		<Tooltip.Root>
			<Tooltip.Trigger>
				<Button
					variant="ghost"
					size="icon"
					onclick={() => (store.showMinimap = !store.showMinimap)}
					class="h-7 w-7 {store.showMinimap ? 'bg-accent text-accent-foreground' : ''}"
				>
					<Map size={14} />
				</Button>
			</Tooltip.Trigger>
			<Tooltip.Content>Toggle minimap</Tooltip.Content>
		</Tooltip.Root>
		<Tooltip.Root>
			<Tooltip.Trigger>
				<Button
					variant="ghost"
					size="icon"
					onclick={() => (store.showRunsPanel = !store.showRunsPanel)}
					class="h-7 w-7 {store.showRunsPanel ? 'bg-accent text-accent-foreground' : ''}"
				>
					<ListOrdered size={14} />
				</Button>
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

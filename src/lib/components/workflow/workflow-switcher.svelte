<script lang="ts">
	/**
	 * Quick-switcher dropdown for navigating between workflows.
	 * Uses Popover + Command (searchable list) — like VS Code's Ctrl+P.
	 */
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';
	import { ChevronsUpDown, Check, FileText, ArrowRight } from 'lucide-svelte';
	import * as Popover from '$lib/components/ui/popover';
	import * as Command from '$lib/components/ui/command';
	import { Button } from '$lib/components/ui/button';
	import { formatDistanceToNow } from 'date-fns';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');

	interface WorkflowItem {
		id: string;
		name: string;
		updatedAt: string;
	}

	let open = $state(false);
	let workflows = $state<WorkflowItem[]>([]);
	let loaded = $state(false);
	let searchQuery = $state('');

	async function loadWorkflows() {
		if (loaded) return;
		try {
			const res = await fetch('/api/workflows?limit=20');
			if (res.ok) {
				workflows = await res.json();
				loaded = true;
			}
		} catch {
			// Silently fail
		}
	}

	// Lazy-load on first open
	$effect(() => {
		if (open && !loaded) {
			loadWorkflows();
		}
	});

	function selectWorkflow(id: string) {
		open = false;
		if (id === store.workflowId) return;
		goto(`/workflows/${id}`);
	}

	function goToAll() {
		open = false;
		goto('/workflows');
	}

	function formatTime(dateStr: string): string {
		try {
			return formatDistanceToNow(new Date(dateStr), { addSuffix: true });
		} catch {
			return '';
		}
	}

	// Expose open method for keyboard shortcut
	export function toggle() {
		open = !open;
		if (open && !loaded) loadWorkflows();
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger class="flex items-center gap-1.5 rounded-md border border-border/50 bg-background/50 px-2.5 py-1 hover:bg-accent/50 transition-colors">
		<span class="text-xs font-medium text-card-foreground truncate max-w-[200px]">
			{store.workflowName || 'Untitled'}
		</span>
		<ChevronsUpDown size={12} class="shrink-0 text-muted-foreground" />
	</Popover.Trigger>

	<Popover.Content class="w-[300px] p-0" align="start" sideOffset={8}>
		<Command.Root>
			<Command.Input placeholder="Search workflows..." class="h-9" />
			<Command.List class="max-h-[300px]">
				<Command.Empty>No workflows found.</Command.Empty>

				<Command.Group heading="Recent">
					{#each workflows as wf (wf.id)}
						<Command.Item
							value={wf.name}
							onSelect={() => selectWorkflow(wf.id)}
							class="flex items-center gap-2"
						>
							<FileText size={14} class="shrink-0 text-muted-foreground" />
							<div class="min-w-0 flex-1">
								<div class="truncate text-xs">{wf.name || 'Untitled'}</div>
								<div class="text-[10px] text-muted-foreground">{formatTime(wf.updatedAt)}</div>
							</div>
							{#if wf.id === store.workflowId}
								<Check size={14} class="shrink-0 text-primary" />
							{/if}
						</Command.Item>
					{/each}
				</Command.Group>

				<Command.Separator />

				<Command.Item
					value="view-all-workflows"
					onSelect={goToAll}
					class="flex items-center gap-2"
				>
					<ArrowRight size={14} class="text-muted-foreground" />
					<span class="text-xs">View all workflows</span>
				</Command.Item>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>

<script lang="ts">
	import { Plus, GitBranch, Trash2, Sparkles } from 'lucide-svelte';
	import { formatDistanceToNow } from 'date-fns';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import AiGenerateDialog from '$lib/components/workflow/ai-generate-dialog.svelte';

	let showAiDialog = $state(false);

	interface Workflow {
		id: string;
		name: string;
		engineType?: string;
		updatedAt: string;
		createdAt: string;
	}

	let workflows = $state<Workflow[]>([]);
	let isLoading = $state(true);

	function formatTime(iso: string): string {
		try {
			return formatDistanceToNow(new Date(iso), { addSuffix: true });
		} catch {
			return iso;
		}
	}

	async function loadWorkflows() {
		try {
			const res = await fetch('/api/workflows');
			if (res.ok) {
				workflows = await res.json();
			}
		} catch (err) {
			console.error('Failed to load workflows:', err);
		} finally {
			isLoading = false;
		}
	}

	async function createWorkflow() {
		try {
			const res = await fetch('/api/workflows', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: 'Untitled Workflow',
					nodes: [
						{
							id: '__start__',
							type: 'start',
							position: { x: 250, y: 50 },
							data: { label: 'Start', status: 'idle', taskType: 'start' }
						},
						{
							id: '__end__',
							type: 'end',
							position: { x: 250, y: 300 },
							data: { label: 'End', status: 'idle', taskType: 'end' }
						}
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
		}
	}

	async function deleteWorkflow(id: string, name: string) {
		if (!confirm(`Delete "${name}"?`)) return;
		try {
			await fetch(`/api/workflows/${id}`, { method: 'DELETE' });
			workflows = workflows.filter((w) => w.id !== id);
		} catch (err) {
			console.error('Failed to delete workflow:', err);
		}
	}

	$effect(() => {
		loadWorkflows();
	});
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<h1 class="text-sm font-semibold tracking-tight">Workflows</h1>
		<div class="flex items-center gap-2">
			<Button variant="outline" size="sm" onclick={() => (showAiDialog = true)}>
				<Sparkles size={14} />
				Generate with AI
			</Button>
			<Button size="sm" onclick={createWorkflow}>
				<Plus size={14} />
				New Workflow
			</Button>
		</div>
	</header>

	<AiGenerateDialog open={showAiDialog} onClose={() => (showAiDialog = false)} />

	<div class="flex-1 overflow-auto p-6">
		{#if isLoading}
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
				{#each Array(8) as _}
					<div class="rounded-lg border border-border bg-card p-4">
						<div class="flex items-start gap-3">
							<Skeleton class="h-8 w-8 rounded-md" />
							<div class="flex-1 space-y-2">
								<Skeleton class="h-4 w-3/4" />
								<Skeleton class="h-3 w-1/2" />
							</div>
						</div>
						<div class="mt-3">
							<Skeleton class="h-5 w-12" />
						</div>
					</div>
				{/each}
			</div>
		{:else if workflows.length === 0}
			<div class="flex flex-col items-center justify-center py-20">
				<div class="rounded-xl bg-muted/50 p-4 mb-4">
					<GitBranch size={32} class="text-muted-foreground" />
				</div>
				<h3 class="text-lg font-medium mb-1">No workflows yet</h3>
				<p class="text-sm text-muted-foreground mb-6">Create your first workflow to get started.</p>
				<Button onclick={createWorkflow}>
					<Plus size={16} />
					Create your first workflow
				</Button>
			</div>
		{:else}
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
				{#each workflows as workflow}
					<a
						href="/workflows/{workflow.id}"
						class="group relative rounded-lg border border-border bg-card p-4 shadow-xs transition-all hover:border-primary/30 hover:shadow-md"
					>
						<div class="flex items-start gap-3">
							<div class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary/10">
								<GitBranch size={14} class="text-primary" />
							</div>
							<div class="min-w-0 flex-1">
								<h3 class="truncate text-sm font-medium text-card-foreground group-hover:text-primary transition-colors">
									{workflow.name}
								</h3>
								<p class="mt-1 text-xs text-muted-foreground">
									Updated {formatTime(workflow.updatedAt)}
								</p>
							</div>
						</div>
						<div class="mt-3 flex items-center justify-between">
							{#if workflow.engineType}
								<Badge variant="secondary" class="text-[10px]">
									{workflow.engineType === 'dapr' ? 'SW 1.0' : workflow.engineType}
								</Badge>
							{:else}
								<span></span>
							{/if}
							<Button
								variant="ghost"
								size="icon"
								class="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive hover:bg-destructive/10"
								onclick={(e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); deleteWorkflow(workflow.id, workflow.name); }}
								title="Delete workflow"
							>
								<Trash2 size={14} />
							</Button>
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</div>
</div>

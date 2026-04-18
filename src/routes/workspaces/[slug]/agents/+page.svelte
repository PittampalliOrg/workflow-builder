<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import {
		AlertDialog,
		AlertDialogAction,
		AlertDialogCancel,
		AlertDialogContent,
		AlertDialogDescription,
		AlertDialogFooter,
		AlertDialogHeader,
		AlertDialogTitle
	} from '$lib/components/ui/alert-dialog';
	import { Copy, FileUp, Plus, Sparkles, Trash2, Workflow } from 'lucide-svelte';
	import ResourceListShell from '$lib/components/console/resource-list-shell.svelte';
	import type { AgentSummary } from '$lib/types/agents';

	let agents = $state<AgentSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');
	let selectedTag = $state<string | null>(null);
	let agentToDelete = $state<AgentSummary | null>(null);
	let busyId = $state<string | null>(null);

	let tags = $derived.by(() => {
		const all = new Set<string>();
		for (const a of agents) for (const t of a.tags) all.add(t);
		return Array.from(all).sort();
	});
	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		return agents.filter((a) => {
			if (q) {
				const hay = `${a.name} ${a.slug} ${a.description ?? ''}`.toLowerCase();
				if (!hay.includes(q)) return false;
			}
			if (selectedTag && !a.tags.includes(selectedTag)) return false;
			return true;
		});
	});

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/agents');
			if (!res.ok) {
				errorMessage = `Failed to load agents (${res.status})`;
				return;
			}
			const data = (await res.json()) as { agents: AgentSummary[] };
			agents = data.agents ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function duplicate(agent: AgentSummary) {
		busyId = agent.id;
		try {
			const res = await fetch(`/api/agents/${agent.id}/duplicate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}'
			});
			if (!res.ok) {
				errorMessage = `Duplicate failed (${res.status})`;
				return;
			}
			await load();
		} finally {
			busyId = null;
		}
	}

	async function confirmDelete() {
		if (!agentToDelete) return;
		busyId = agentToDelete.id;
		try {
			const res = await fetch(`/api/agents/${agentToDelete.id}`, { method: 'DELETE' });
			if (!res.ok) {
				errorMessage = `Delete failed (${res.status})`;
				return;
			}
			agents = agents.filter((a) => a.id !== agentToDelete!.id);
		} finally {
			busyId = null;
			agentToDelete = null;
		}
	}

	async function importMarkdownFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const source = await file.text();
			const res = await fetch('/api/v1/agents/import', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ source })
			});
			if (!res.ok) {
				errorMessage = `Import failed (${res.status}): ${await res.text()}`;
				return;
			}
			const { agent } = (await res.json()) as { agent: AgentSummary };
			goto(`/workspaces/default/agents/${agent.id}`);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			input.value = '';
		}
	}

	onMount(load);
</script>

<ResourceListShell
	title="Agents"
	subtitle="Create and manage autonomous agents."
	itemLabel="agent"
	itemCount={agents.length}
	onSearch={(v) => (search = v)}
	searchPlaceholder="Search agents…"
	primaryLabel="New Agent"
	onPrimary={() => goto('/workspaces/default/agents/new')}
	{loading}
	{errorMessage}
	isEmpty={filtered.length === 0}
	{content}
	{empty}
	{filters}
	{actions}
/>

{#snippet actions()}
	<Button variant="outline" onclick={() => goto('/workspaces/default/agents/quickstart')}>
		<Sparkles class="size-4" /> From template
	</Button>
	<label class="relative cursor-pointer">
		<input
			type="file"
			accept=".md,text/markdown,text/plain"
			class="sr-only"
			onchange={importMarkdownFile}
		/>
		<span
			class="inline-flex items-center gap-1 h-9 px-3 rounded-md border bg-background text-sm hover:bg-muted transition-colors"
		>
			<FileUp class="size-4" /> Import .md
		</span>
	</label>
{/snippet}

{#snippet filters()}
	{#if tags.length > 0}
		<div class="flex flex-wrap gap-2 items-center text-sm">
			<span class="text-muted-foreground">Tags:</span>
			<button
				type="button"
				class="px-2 py-0.5 rounded border {selectedTag === null
					? 'bg-primary text-primary-foreground'
					: 'bg-muted hover:bg-muted/80'}"
				onclick={() => (selectedTag = null)}>All</button
			>
			{#each tags as tag (tag)}
				<button
					type="button"
					class="px-2 py-0.5 rounded border {selectedTag === tag
						? 'bg-primary text-primary-foreground'
						: 'bg-muted hover:bg-muted/80'}"
					onclick={() => (selectedTag = selectedTag === tag ? null : tag)}>#{tag}</button
				>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet content()}
	<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
		{#each filtered as agent (agent.id)}
			<Card class="group relative hover:shadow-md transition-shadow cursor-pointer">
				<div class="absolute right-3 top-3 hidden group-hover:flex gap-1 z-10">
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						onclick={(e) => {
							e.stopPropagation();
							duplicate(agent);
						}}
						disabled={busyId === agent.id}
						title="Duplicate"
					>
						<Copy class="size-3.5" />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						class="size-7 text-destructive"
						onclick={(e) => {
							e.stopPropagation();
							agentToDelete = agent;
						}}
						disabled={busyId === agent.id}
						title="Archive"
					>
						<Trash2 class="size-3.5" />
					</Button>
				</div>
				<button
					type="button"
					class="text-left w-full h-full"
					onclick={() => goto(`/workspaces/default/agents/${agent.id}`)}
				>
					<CardHeader>
						<div class="flex items-center gap-2">
							<div
								class="size-10 rounded bg-primary/10 flex items-center justify-center text-xl"
							>
								{agent.avatar ?? '🤖'}
							</div>
							<div class="flex-1 min-w-0">
								<CardTitle class="truncate text-base">{agent.name}</CardTitle>
								<CardDescription class="truncate text-xs">
									{agent.slug}
								</CardDescription>
							</div>
						</div>
					</CardHeader>
					<CardContent class="space-y-3">
						<p class="text-xs text-muted-foreground line-clamp-2 min-h-[2.4em]">
							{agent.description ?? 'No description'}
						</p>
						<div class="flex items-center gap-2 flex-wrap">
							{#if agent.modelSpec}
								<Badge variant="outline" class="font-mono text-[10px]">
									{agent.modelSpec}
								</Badge>
							{/if}
							<Badge variant="secondary" class="text-[10px]">
								v{agent.currentVersion ?? '—'}
							</Badge>
							{#if agent.usedByCount !== undefined}
								<Badge variant="outline" class="text-[10px]">
									<Workflow class="size-3 mr-1" />
									{agent.usedByCount} workflow{agent.usedByCount === 1 ? '' : 's'}
								</Badge>
							{/if}
						</div>
						{#if agent.tags.length > 0}
							<div class="flex flex-wrap gap-1">
								{#each agent.tags as tag (tag)}
									<span class="text-[10px] px-1.5 py-0.5 rounded bg-muted">#{tag}</span>
								{/each}
							</div>
						{/if}
					</CardContent>
				</button>
			</Card>
		{/each}
	</div>
{/snippet}

{#snippet empty()}
	{#if agents.length === 0}
		<div class="flex flex-col items-center justify-center text-center py-16">
			<div
				class="size-20 rounded-full bg-primary/10 flex items-center justify-center text-4xl mb-4"
			>
				🤖
			</div>
			<h2 class="text-xl font-semibold mb-2">Create your first agent</h2>
			<p class="text-muted-foreground mb-6 max-w-md">
				Define an agent once — model, prompts, MCP servers, skills, hooks — and reference it from
				any workflow. Start from a template or build from scratch.
			</p>
			<div class="flex gap-3">
				<Button onclick={() => goto('/workspaces/default/agents/quickstart')} size="lg">
					<Plus class="size-4 mr-1" /> Start from a template
				</Button>
			</div>
		</div>
	{:else}
		<div class="text-center text-muted-foreground py-12">No agents match your filters.</div>
	{/if}
{/snippet}

<AlertDialog
	open={agentToDelete !== null}
	onOpenChange={(open) => !open && (agentToDelete = null)}
>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Archive {agentToDelete?.name}?</AlertDialogTitle>
			<AlertDialogDescription>
				The agent will be hidden from the library. Workflows that pinned a specific version will
				keep working. To permanently delete data, use the database directly.
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={confirmDelete}>Archive</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

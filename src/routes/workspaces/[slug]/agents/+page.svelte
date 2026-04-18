<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';
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
	import { ArrowRight, Copy, FileUp, Plus, Sparkles, Trash2 } from 'lucide-svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import RowMoreActions from '$lib/components/console/row-more-actions.svelte';
	import type { AgentSummary } from '$lib/types/agents';
	import { page } from '$app/state';

	const slug = $derived((page.params.slug as string) ?? 'default');

	let agents = $state<AgentSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let includeArchived = $state(false);
	let includeEphemeral = $state(false);
	let jumpId = $state('');
	let created = $state<'all' | '7d' | '30d' | '90d'>('all');
	let agentToDelete = $state<AgentSummary | null>(null);
	let busyId = $state<string | null>(null);

	const filtered = $derived.by(() => {
		const now = Date.now();
		const cutoff =
			created === '7d'
				? now - 7 * 86_400_000
				: created === '30d'
					? now - 30 * 86_400_000
					: created === '90d'
						? now - 90 * 86_400_000
						: 0;
		return agents.filter((a) => {
			if (cutoff && new Date(a.createdAt).getTime() < cutoff) return false;
			return true;
		});
	});

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const params = new URLSearchParams();
			if (includeArchived) params.set('includeArchived', 'true');
			if (includeEphemeral) params.set('includeEphemeral', 'true');
			const res = await fetch(`/api/agents?${params}`);
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
			goto(`/workspaces/${slug}/agents/${agent.id}`);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			input.value = '';
		}
	}

	function jumpToAgent() {
		const id = jumpId.trim();
		if (!id) return;
		goto(`/workspaces/${slug}/agents/${id}`);
	}

	function formatRelative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
		return new Date(iso).toLocaleDateString();
	}

	$effect(() => {
		void includeArchived;
		void includeEphemeral;
		void load();
	});

	onMount(() => void load());
</script>

<div class="p-6 space-y-5 max-w-6xl mx-auto w-full">
	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold">Agents</h1>
			<p class="text-sm text-muted-foreground mt-1">Create and manage autonomous agents.</p>
		</div>
		<div class="flex items-center gap-2">
			<Button
				variant="outline"
				onclick={() => goto(`/workspaces/${slug}/agents/quickstart`)}
			>
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
			<Button onclick={() => goto(`/workspaces/${slug}/agents/new`)}>
				<Plus class="size-4" /> New agent
			</Button>
		</div>
	</header>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<div class="flex items-center gap-3 flex-wrap">
		<div class="relative flex-1 min-w-[260px] max-w-md">
			<ArrowRight class="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
			<Input
				class="pl-9 pr-3 h-9"
				placeholder="Go to agent ID"
				bind:value={jumpId}
				onkeydown={(e) => {
					if (e.key === 'Enter') jumpToAgent();
				}}
			/>
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<span class="text-xs text-muted-foreground">Created</span>
			<select
				class="bg-transparent text-sm focus:outline-none"
				bind:value={created}
			>
				<option value="all">All time</option>
				<option value="7d">Past 7 days</option>
				<option value="30d">Past 30 days</option>
				<option value="90d">Past 90 days</option>
			</select>
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<Label for="show-archived" class="text-sm">Show archived</Label>
			<Switch id="show-archived" bind:checked={includeArchived} />
		</div>
		<div class="flex items-center gap-2 h-9 rounded-md border px-3">
			<Label for="show-ephemeral" class="text-sm">Show workflow-spawned</Label>
			<Switch id="show-ephemeral" bind:checked={includeEphemeral} />
		</div>
	</div>

	<ResourceTable
		rows={filtered}
		{loading}
		onRowClick={(a: AgentSummary) => goto(`/workspaces/${slug}/agents/${a.id}`)}
	>
		{#snippet header()}
			<th class="px-4 py-2.5 font-medium">ID</th>
			<th class="px-4 py-2.5 font-medium">Name</th>
			<th class="px-4 py-2.5 font-medium">Model</th>
			<th class="px-4 py-2.5 font-medium">Status</th>
			<th class="px-4 py-2.5 font-medium">Created</th>
			<th class="px-4 py-2.5 font-medium w-10"></th>
		{/snippet}
		{#snippet row(a: AgentSummary)}
			<td class="px-4 py-2.5">
				<CopyIdButton value={a.id} />
			</td>
			<td class="px-4 py-2.5">
				<div class="flex items-center gap-2 min-w-0">
					<span class="text-base">{a.avatar ?? '🤖'}</span>
					<span class="truncate">{a.name}</span>
				</div>
			</td>
			<td class="px-4 py-2.5">
				{#if a.modelSpec}
					<code class="text-[11px] text-muted-foreground">{a.modelSpec}</code>
				{:else}
					<span class="text-xs text-muted-foreground">—</span>
				{/if}
			</td>
			<td class="px-4 py-2.5">
				<Badge variant={a.isArchived ? 'outline' : 'default'} class="text-[10px] bg-green-600/15 text-green-700 dark:text-green-400 border-transparent">
					{a.isArchived ? 'Archived' : 'Active'}
				</Badge>
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground">
				{formatRelative(a.createdAt)}
			</td>
			<td class="px-4 py-2.5" onclick={(e) => e.stopPropagation()}>
				<RowMoreActions
					actions={[
						{
							label: 'Duplicate',
							onClick: () => duplicate(a),
							disabled: busyId === a.id
						},
						{
							label: 'Archive',
							onClick: () => {
								agentToDelete = a;
							},
							destructive: true,
							separator: true,
							disabled: busyId === a.id
						}
					]}
				/>
			</td>
		{/snippet}
		{#snippet empty()}
			<div class="flex flex-col items-center justify-center py-10 space-y-3">
				<div class="size-14 rounded-full bg-primary/10 flex items-center justify-center text-2xl">
					🤖
				</div>
				<h2 class="text-base font-semibold">Create your first agent</h2>
				<p class="text-muted-foreground text-sm max-w-md text-center">
					Define an agent once — model, prompts, MCP servers, skills — and reference it from
					any workflow.
				</p>
				<Button onclick={() => goto(`/workspaces/${slug}/agents/quickstart`)}>
					<Plus class="size-4" /> Start from a template
				</Button>
			</div>
		{/snippet}
	</ResourceTable>
</div>

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

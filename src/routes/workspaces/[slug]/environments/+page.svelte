<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
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
	import { Plus } from 'lucide-svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import RowMoreActions from '$lib/components/console/row-more-actions.svelte';
	import type { EnvironmentSummary } from '$lib/types/environments';
	import { page } from '$app/state';

	const slug = $derived((page.params.slug as string) ?? 'default');

	let environments = $state<EnvironmentSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let tab = $state<'all' | 'active'>('all');
	let toDelete = $state<EnvironmentSummary | null>(null);
	let busyId = $state<string | null>(null);

	const visible = $derived.by(() => {
		return environments.filter((e) => {
			if (tab === 'active' && e.isArchived) return false;
			return true;
		});
	});

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/v1/environments?includeArchived=true');
			if (!res.ok) {
				errorMessage = `Failed to load environments (${res.status})`;
				return;
			}
			const data = (await res.json()) as { environments: EnvironmentSummary[] };
			environments = data.environments ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function duplicate(env: EnvironmentSummary) {
		busyId = env.id;
		try {
			const res = await fetch(`/api/v1/environments/${env.id}/duplicate`, {
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
		if (!toDelete) return;
		busyId = toDelete.id;
		try {
			const res = await fetch(`/api/v1/environments/${toDelete.id}`, { method: 'DELETE' });
			if (!res.ok) {
				errorMessage = `Archive failed (${res.status})`;
				return;
			}
			environments = environments.filter((e) => e.id !== toDelete!.id);
		} finally {
			busyId = null;
			toDelete = null;
		}
	}

	function formatRelative(iso: string): string {
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		return new Date(iso).toLocaleDateString();
	}

	onMount(load);
</script>

<div class="p-6 space-y-5 max-w-6xl mx-auto w-full">
	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold">Environments</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Configuration template for containers, such as sessions or code execution.
			</p>
		</div>
		<Button onclick={() => goto(`/workspaces/${slug}/environments/new`)}>
			<Plus class="size-4" /> Add environment
		</Button>
	</header>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	<div class="inline-flex rounded-md border bg-muted/30 p-0.5">
		<button
			type="button"
			class="px-3 py-1 text-sm rounded {tab === 'all' ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
			onclick={() => (tab = 'all')}
		>
			All
		</button>
		<button
			type="button"
			class="px-3 py-1 text-sm rounded {tab === 'active' ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
			onclick={() => (tab = 'active')}
		>
			Active
		</button>
	</div>

	<ResourceTable
		rows={visible}
		{loading}
		onRowClick={(e: EnvironmentSummary) => goto(`/workspaces/${slug}/environments/${e.id}`)}
	>
		{#snippet header()}
			<th class="px-4 py-2.5 font-medium">ID</th>
			<th class="px-4 py-2.5 font-medium">Name</th>
			<th class="px-4 py-2.5 font-medium">Status</th>
			<th class="px-4 py-2.5 font-medium">Type</th>
			<th class="px-4 py-2.5 font-medium">Created</th>
			<th class="px-4 py-2.5 font-medium w-10"></th>
		{/snippet}
		{#snippet row(env: EnvironmentSummary)}
			<td class="px-4 py-2.5">
				<CopyIdButton value={env.id} />
			</td>
			<td class="px-4 py-2.5">
				<div class="flex items-center gap-2">
					<span class="text-base">{env.avatar ?? '🧱'}</span>
					<span class="truncate">{env.name}</span>
				</div>
			</td>
			<td class="px-4 py-2.5">
				<Badge
					variant={env.isArchived ? 'outline' : 'default'}
					class="text-[10px] bg-green-600/15 text-green-700 dark:text-green-400 border-transparent"
				>
					{env.isArchived ? 'Archived' : 'Active'}
				</Badge>
			</td>
			<td class="px-4 py-2.5">
				<Badge variant="outline" class="text-[10px] font-mono">
					{env.sandboxTemplate ?? 'Cloud'}
				</Badge>
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground">
				{formatRelative(env.createdAt)}
			</td>
			<td class="px-4 py-2.5" onclick={(e) => e.stopPropagation()}>
				<RowMoreActions
					actions={[
						{
							label: 'Duplicate',
							onClick: () => duplicate(env),
							disabled: busyId === env.id
						},
						{
							label: 'Archive',
							onClick: () => {
								toDelete = env;
							},
							destructive: true,
							separator: true,
							disabled: busyId === env.id
						}
					]}
				/>
			</td>
		{/snippet}
		{#snippet empty()}
			<div class="flex flex-col items-center justify-center py-10 space-y-3">
				<div class="size-14 rounded-full bg-primary/10 flex items-center justify-center text-2xl">
					🧱
				</div>
				<h2 class="text-base font-semibold">No environments yet</h2>
				<p class="text-muted-foreground text-sm max-w-md text-center">
					Environments bundle a sandbox template, networking policy, and package list. Agents
					reference environments so the same config can drive many agents.
				</p>
				<Button onclick={() => goto(`/workspaces/${slug}/environments/new`)}>
					<Plus class="size-4" /> Add environment
				</Button>
			</div>
		{/snippet}
	</ResourceTable>
</div>

<AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && (toDelete = null)}>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Archive {toDelete?.name}?</AlertDialogTitle>
			<AlertDialogDescription>
				Archived environments stay referenced by existing agents but can't be picked for new ones.
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={confirmDelete}>Archive</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

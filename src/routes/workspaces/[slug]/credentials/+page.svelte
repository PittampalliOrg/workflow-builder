<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogFooter,
		DialogHeader,
		DialogTitle
	} from '$lib/components/ui/dialog';
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
	import { Plus, ShieldCheck } from '@lucide/svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import ResourceTable from '$lib/components/console/resource-table.svelte';
	import RowMoreActions from '$lib/components/console/row-more-actions.svelte';
	import type { VaultSummary } from '$lib/types/vaults';
	import { page } from '$app/state';

	const slug = $derived((page.params.slug as string) ?? 'default');

	let vaults = $state<VaultSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let tab = $state<'all' | 'active'>('all');
	let toDelete = $state<VaultSummary | null>(null);
	let busyId = $state<string | null>(null);
	let createDialogOpen = $state(false);
	let newName = $state('');
	let newDescription = $state('');
	let creating = $state(false);

	const visible = $derived.by(() => {
		return vaults.filter((v) => {
			if (tab === 'active' && v.isArchived) return false;
			return true;
		});
	});

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/v1/vaults?includeArchived=true');
			if (!res.ok) {
				errorMessage = `Failed to load vaults (${res.status})`;
				return;
			}
			const data = (await res.json()) as { vaults: VaultSummary[] };
			vaults = data.vaults ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function createVault() {
		if (!newName.trim()) return;
		creating = true;
		try {
			const res = await fetch('/api/v1/vaults', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: newName.trim(),
					description: newDescription.trim() || null
				})
			});
			if (!res.ok) {
				errorMessage = `Create failed (${res.status}): ${await res.text()}`;
				return;
			}
			const { vault } = await res.json();
			createDialogOpen = false;
			newName = '';
			newDescription = '';
			goto(`/workspaces/${slug}/credentials/${vault.id}`);
		} finally {
			creating = false;
		}
	}

	async function confirmDelete() {
		if (!toDelete) return;
		busyId = toDelete.id;
		try {
			const res = await fetch(`/api/v1/vaults/${toDelete.id}`, { method: 'DELETE' });
			if (!res.ok) {
				errorMessage = `Archive failed (${res.status})`;
				return;
			}
			vaults = vaults.filter((v) => v.id !== toDelete!.id);
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

<div class="h-full overflow-y-auto p-6 space-y-5 max-w-6xl mx-auto w-full">
	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold">Credentials</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Grouped credential stores that provide your agents with access to MCP servers, APIs, and
				connected integrations.
			</p>
		</div>
		<Button onclick={() => (createDialogOpen = true)}>
			<Plus class="size-4" /> New credential store
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
		onRowClick={(v: VaultSummary) => goto(`/workspaces/${slug}/credentials/${v.id}`)}
	>
		{#snippet header()}
			<th class="px-4 py-2.5 font-medium">ID</th>
			<th class="px-4 py-2.5 font-medium">Name</th>
			<th class="px-4 py-2.5 font-medium">Status</th>
			<th class="px-4 py-2.5 font-medium">Credentials</th>
			<th class="px-4 py-2.5 font-medium">Created</th>
			<th class="px-4 py-2.5 font-medium w-10"></th>
		{/snippet}
		{#snippet row(vault: VaultSummary)}
			<td class="px-4 py-2.5">
				<CopyIdButton value={vault.id} />
			</td>
			<td class="px-4 py-2.5 truncate">{vault.name}</td>
			<td class="px-4 py-2.5">
				<Badge
					variant={vault.isArchived ? 'outline' : 'default'}
					class="text-[10px] bg-green-600/15 text-green-700 dark:text-green-400 border-transparent"
				>
					{vault.isArchived ? 'Archived' : 'Active'}
				</Badge>
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground">
				{vault.credentialCount}
			</td>
			<td class="px-4 py-2.5 text-xs text-muted-foreground">
				{formatRelative(vault.createdAt)}
			</td>
			<td class="px-4 py-2.5" onclick={(e) => e.stopPropagation()}>
				<RowMoreActions
					actions={[
						{
							label: 'Archive',
							onClick: () => {
								toDelete = vault;
							},
							destructive: true,
							disabled: busyId === vault.id
						}
					]}
				/>
			</td>
		{/snippet}
		{#snippet empty()}
			<div class="flex flex-col items-center justify-center py-10 space-y-3">
				<div class="size-14 rounded-full bg-primary/10 flex items-center justify-center">
					<ShieldCheck class="size-7 text-primary" />
				</div>
				<h2 class="text-base font-semibold">No vaults yet</h2>
				<p class="text-muted-foreground text-sm max-w-md text-center">
					Create your first vault to get started.
				</p>
				<Button onclick={() => (createDialogOpen = true)}>
					<Plus class="size-4" /> New vault
				</Button>
			</div>
		{/snippet}
	</ResourceTable>
</div>

<Dialog bind:open={createDialogOpen}>
	<DialogContent>
		<DialogHeader>
			<DialogTitle>New vault</DialogTitle>
			<DialogDescription>Group credentials by tenant, project, or integration.</DialogDescription>
		</DialogHeader>
		<div class="space-y-3">
			<div>
				<Label for="vault-name">Name</Label>
				<Input id="vault-name" bind:value={newName} placeholder="e.g. Production MCP" />
			</div>
			<div>
				<Label for="vault-desc">Description</Label>
				<Textarea id="vault-desc" bind:value={newDescription} rows={2} />
			</div>
		</div>
		<DialogFooter>
			<Button variant="outline" onclick={() => (createDialogOpen = false)}>Cancel</Button>
			<Button onclick={createVault} disabled={!newName.trim() || creating}>
				{creating ? 'Creating…' : 'Create'}
			</Button>
		</DialogFooter>
	</DialogContent>
</Dialog>

<AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && (toDelete = null)}>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Archive {toDelete?.name}?</AlertDialogTitle>
			<AlertDialogDescription>
				Credentials in archived vaults are not returned at tool-call time. Agents that reference
				them will fail MCP auth.
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={confirmDelete}>Archive</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

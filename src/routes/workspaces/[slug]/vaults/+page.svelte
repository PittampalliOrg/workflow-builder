<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		Card,
		CardContent,
		CardDescription,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
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
	import { KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-svelte';
	import ResourceListShell from '$lib/components/console/resource-list-shell.svelte';
	import type { VaultSummary } from '$lib/types/vaults';

	let vaults = $state<VaultSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');
	let toDelete = $state<VaultSummary | null>(null);
	let busyId = $state<string | null>(null);
	let createDialogOpen = $state(false);
	let newName = $state('');
	let newDescription = $state('');
	let creating = $state(false);

	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return vaults;
		return vaults.filter((v) => {
			const hay = `${v.name} ${v.description ?? ''}`.toLowerCase();
			return hay.includes(q);
		});
	});

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/v1/vaults');
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
			goto(`/workspaces/default/vaults/${vault.id}`);
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

	onMount(load);
</script>

<ResourceListShell
	title="Credential vaults"
	subtitle="Store encrypted credentials for MCP servers. Vaults are attached to sessions by id; the proxy injects them at tool-call time so the sandbox never sees them."
	itemLabel="vault"
	itemCount={vaults.length}
	onSearch={(v) => (search = v)}
	primaryLabel="New vault"
	onPrimary={() => (createDialogOpen = true)}
	{loading}
	{errorMessage}
	isEmpty={vaults.length === 0 || filtered.length === 0}
	{content}
	{empty}
/>

{#snippet content()}
	<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
		{#each filtered as vault (vault.id)}
			<Card class="group relative hover:shadow-md transition-shadow cursor-pointer">
				<div class="absolute right-3 top-3 hidden group-hover:flex gap-1 z-10">
					<Button
						variant="ghost"
						size="icon"
						class="size-7 text-destructive"
						onclick={(e) => {
							e.stopPropagation();
							toDelete = vault;
						}}
						disabled={busyId === vault.id}
						title="Archive"
					>
						<Trash2 class="size-3.5" />
					</Button>
				</div>
				<button
					type="button"
					class="text-left w-full h-full"
					onclick={() => goto(`/workspaces/default/vaults/${vault.id}`)}
				>
					<CardHeader>
						<div class="flex items-center gap-2">
							<div class="size-10 rounded bg-primary/10 flex items-center justify-center">
								<KeyRound class="size-5 text-primary" />
							</div>
							<div class="flex-1 min-w-0">
								<CardTitle class="truncate text-base">{vault.name}</CardTitle>
								<CardDescription class="truncate text-xs">
									{vault.credentialCount} credential{vault.credentialCount === 1 ? '' : 's'}
								</CardDescription>
							</div>
						</div>
					</CardHeader>
					<CardContent>
						<p class="text-xs text-muted-foreground line-clamp-2 min-h-[2.4em]">
							{vault.description ?? 'No description'}
						</p>
					</CardContent>
				</button>
			</Card>
		{/each}
	</div>
{/snippet}

{#snippet empty()}
	{#if vaults.length === 0}
		<div class="flex flex-col items-center justify-center text-center py-16">
			<div class="size-20 rounded-full bg-primary/10 flex items-center justify-center mb-4">
				<ShieldCheck class="size-10 text-primary" />
			</div>
			<h2 class="text-xl font-semibold mb-2">No vaults yet</h2>
			<p class="text-muted-foreground mb-6 max-w-md">
				Vaults hold OAuth tokens, bearer tokens, and other credentials your agents need for MCP
				servers and custom tools. Credentials auto-refresh and never enter the sandbox.
			</p>
			<Button onclick={() => (createDialogOpen = true)} size="lg">
				<Plus class="size-4 mr-1" /> Create your first vault
			</Button>
		</div>
	{:else}
		<div class="text-center text-muted-foreground py-12">No vaults match your search.</div>
	{/if}
{/snippet}

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

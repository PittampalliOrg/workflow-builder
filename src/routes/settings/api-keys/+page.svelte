<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
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
	import { Copy, DollarSign, Key, Plus, RefreshCw, Trash2 } from 'lucide-svelte';

	type ApiKeyRow = {
		id: string;
		name: string | null;
		keyPrefix: string;
		createdAt: string;
		lastUsedAt: string | null;
	};

	let keys = $state<ApiKeyRow[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let createOpen = $state(false);
	let newName = $state('');
	let creating = $state(false);
	let newSecret = $state<string | null>(null);
	let toDelete = $state<ApiKeyRow | null>(null);
	let busyId = $state<string | null>(null);
	let toRotate = $state<ApiKeyRow | null>(null);

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/settings/api-keys');
			if (!res.ok) {
				errorMessage = `Failed to load (${res.status})`;
				return;
			}
			keys = (await res.json()) as ApiKeyRow[];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function createKey() {
		if (!newName.trim()) return;
		creating = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/settings/api-keys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name: newName.trim() })
			});
			if (!res.ok) {
				errorMessage = `Create failed (${res.status})`;
				return;
			}
			const row = await res.json();
			newSecret = row.key;
			newName = '';
			await load();
		} finally {
			creating = false;
		}
	}

	async function rotate() {
		if (!toRotate) return;
		busyId = toRotate.id;
		errorMessage = null;
		try {
			const res = await fetch(`/api/settings/api-keys/${toRotate.id}/rotate`, {
				method: 'POST'
			});
			if (!res.ok) {
				errorMessage = `Rotate failed (${res.status})`;
				return;
			}
			const row = await res.json();
			newSecret = row.key; // reuse the create dialog's "secret shown once" flow
			toRotate = null;
			createOpen = true;
			await load();
		} finally {
			busyId = null;
		}
	}

	async function revoke() {
		if (!toDelete) return;
		busyId = toDelete.id;
		try {
			const res = await fetch(`/api/settings/api-keys/${toDelete.id}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				errorMessage = `Revoke failed (${res.status})`;
				return;
			}
			keys = keys.filter((k) => k.id !== toDelete!.id);
		} finally {
			busyId = null;
			toDelete = null;
		}
	}

	function formatRelative(iso: string | null): string {
		if (!iso) return 'Never';
		const diff = Date.now() - new Date(iso).getTime();
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
		if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
		return `${Math.floor(diff / (30 * 86_400_000))}mo ago`;
	}

	async function copySecret() {
		if (!newSecret) return;
		try {
			await navigator.clipboard.writeText(newSecret);
		} catch {
			/* clipboard unavailable */
		}
	}

	onMount(load);
</script>

<div class="space-y-6">
	<div class="flex items-center justify-between">
		<div>
			<h2 class="text-lg font-semibold flex items-center gap-2">
				<Key class="size-4" /> API keys
			</h2>
			<p class="text-xs text-muted-foreground mt-1">
				API keys are owned by workspaces and remain active even after the creator is removed.
			</p>
		</div>
		<Button onclick={() => (createOpen = true)}>
			<Plus class="size-4" /> Create key
		</Button>
	</div>

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	{#if loading}
		<Skeleton class="h-40" />
	{:else if keys.length === 0}
		<div class="border rounded-lg p-12 text-center text-sm text-muted-foreground">
			<Key class="size-10 mx-auto mb-3 opacity-40" />
			No API keys yet. Create one to authenticate programmatic access.
		</div>
	{:else}
		<div class="border rounded-lg overflow-hidden">
			<table class="w-full text-sm">
				<thead class="bg-muted/30">
					<tr class="text-left text-[11px] uppercase tracking-wide text-muted-foreground border-b">
						<th class="p-3 font-medium">Key</th>
						<th class="p-3 font-medium">Created</th>
						<th class="p-3 font-medium">Last used</th>
						<th class="p-3 font-medium text-right">Cost (30d)</th>
						<th class="p-3 font-medium w-12"></th>
					</tr>
				</thead>
				<tbody>
					{#each keys as key (key.id)}
						<tr class="border-b last:border-0 hover:bg-muted/20">
							<td class="p-3">
								<div class="font-medium">{key.name ?? 'Unnamed'}</div>
								<div class="font-mono text-[11px] text-muted-foreground">{key.keyPrefix}</div>
							</td>
							<td class="p-3 text-xs text-muted-foreground">
								{new Date(key.createdAt).toLocaleDateString()}
							</td>
							<td class="p-3 text-xs text-muted-foreground">
								{formatRelative(key.lastUsedAt)}
							</td>
							<td class="p-3 text-right">
								<button
									type="button"
									class="text-xs text-primary hover:underline inline-flex items-center gap-1"
									onclick={() => goto(`/cost?api_key=${key.id}`)}
								>
									<DollarSign class="size-3" /> View cost
								</button>
							</td>
							<td class="p-3 flex items-center justify-end gap-1">
								<Button
									variant="ghost"
									size="icon"
									class="size-7"
									onclick={() => (toRotate = key)}
									disabled={busyId === key.id}
									title="Rotate key"
								>
									<RefreshCw class="size-3.5" />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									class="size-7 text-destructive"
									onclick={() => (toDelete = key)}
									disabled={busyId === key.id}
									title="Revoke"
								>
									<Trash2 class="size-3.5" />
								</Button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<Dialog
	open={createOpen}
	onOpenChange={(open) => {
		createOpen = open;
		if (!open) newSecret = null;
	}}
>
	<DialogContent>
		<DialogHeader>
			<DialogTitle>Create API key</DialogTitle>
			<DialogDescription>
				Give the key a recognizable name. The secret will only be shown once.
			</DialogDescription>
		</DialogHeader>

		{#if newSecret}
			<div class="space-y-3">
				<Alert>
					<AlertDescription class="text-xs">
						Copy this key now — it will not be shown again.
					</AlertDescription>
				</Alert>
				<div class="relative">
					<Input value={newSecret} readonly class="font-mono text-xs pr-10" />
					<Button
						variant="ghost"
						size="icon"
						class="absolute right-1 top-1 size-7"
						onclick={copySecret}
					>
						<Copy class="size-3.5" />
					</Button>
				</div>
			</div>
			<DialogFooter>
				<Button onclick={() => (createOpen = false)}>Done</Button>
			</DialogFooter>
		{:else}
			<div class="space-y-3">
				<div>
					<Label for="key-name">Name</Label>
					<Input id="key-name" bind:value={newName} placeholder="e.g. CI deploy key" />
				</div>
			</div>
			<DialogFooter>
				<Button variant="outline" onclick={() => (createOpen = false)}>Cancel</Button>
				<Button onclick={createKey} disabled={!newName.trim() || creating}>
					{creating ? 'Creating…' : 'Create'}
				</Button>
			</DialogFooter>
		{/if}
	</DialogContent>
</Dialog>

<AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && (toDelete = null)}>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Revoke {toDelete?.name ?? 'this key'}?</AlertDialogTitle>
			<AlertDialogDescription>
				Any clients using this key will immediately lose access. This cannot be undone.
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={revoke}>Revoke</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

<AlertDialog open={toRotate !== null} onOpenChange={(open) => !open && (toRotate = null)}>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Rotate {toRotate?.name ?? 'this key'}?</AlertDialogTitle>
			<AlertDialogDescription>
				A new secret will be generated. The existing secret stops working immediately —
				update any clients holding the old value. The key id stays the same.
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={rotate}>Rotate</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

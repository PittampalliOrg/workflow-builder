<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import ResourceListShell from '$lib/components/console/resource-list-shell.svelte';
	import { Briefcase, Check, Pencil, Plus } from '@lucide/svelte';

	type Workspace = {
		id: string;
		displayName: string;
		externalId: string;
		slug: string;
		role: 'ADMIN' | 'EDITOR' | 'OPERATOR' | 'VIEWER';
		isCurrent: boolean;
		createdAt: string;
	};

	let workspaces = $state<Workspace[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');

	let createOpen = $state(false);
	let createName = $state('');
	let creating = $state(false);

	let renameTarget = $state<Workspace | null>(null);
	let renameDraft = $state('');
	let renaming = $state(false);

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/v1/workspaces');
			if (!res.ok) {
				errorMessage = `Failed to load workspaces (${res.status})`;
				return;
			}
			const body = (await res.json()) as { workspaces: Workspace[] };
			workspaces = body.workspaces ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	const filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return workspaces;
		return workspaces.filter(
			(w) =>
				w.displayName.toLowerCase().includes(q) ||
				w.externalId.toLowerCase().includes(q)
		);
	});

	async function createWorkspace() {
		if (!createName.trim()) return;
		creating = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/v1/workspaces', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ displayName: createName.trim() })
			});
			if (!res.ok) {
				errorMessage = `Create failed (${res.status}): ${(await res.text()).slice(0, 200)}`;
				return;
			}
			const body = (await res.json()) as { workspace: Workspace };
			createOpen = false;
			createName = '';
			// Land the user on the new workspace's Agents page.
			if (body.workspace?.externalId) {
				goto(`/workspaces/${body.workspace.externalId}/agents`);
			} else {
				await load();
			}
		} finally {
			creating = false;
		}
	}

	async function applyRename() {
		if (!renameTarget || !renameDraft.trim()) return;
		renaming = true;
		try {
			const res = await fetch(`/api/v1/workspaces/${renameTarget.id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ displayName: renameDraft.trim() })
			});
			if (!res.ok) {
				errorMessage = `Rename failed (${res.status})`;
				return;
			}
			renameTarget = null;
			renameDraft = '';
			await load();
		} finally {
			renaming = false;
		}
	}

	function openWorkspace(w: Workspace) {
		goto(`/workspaces/${w.slug}/agents`);
	}

	onMount(load);
</script>

<ResourceListShell
	title="Workspaces"
	subtitle="Every resource — agents, sessions, environments, vaults, files — is scoped to a workspace. Switch from the sidebar chip or create a new one here."
	itemLabel="workspace"
	itemCount={filtered.length}
	onSearch={(v) => (search = v)}
	primaryLabel="Create workspace"
	onPrimary={() => {
		createName = '';
		createOpen = true;
	}}
	{loading}
	{errorMessage}
	isEmpty={workspaces.length === 0 || filtered.length === 0}
	{content}
	{empty}
/>

{#snippet content()}
	<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
		{#each filtered as w (w.id)}
			<Card
				class="cursor-pointer hover:shadow-md transition-shadow {w.isCurrent
					? 'border-primary'
					: ''}"
			>
				<button type="button" class="text-left w-full h-full" onclick={() => openWorkspace(w)}>
					<CardHeader class="pb-2">
						<div class="flex items-start justify-between gap-2">
							<CardTitle class="text-base flex items-center gap-2">
								<Briefcase class="size-4 text-muted-foreground" />
								{w.displayName}
							</CardTitle>
							{#if w.isCurrent}
								<Badge variant="outline" class="text-[10px] gap-1">
									<Check class="size-3" /> active
								</Badge>
							{/if}
						</div>
						<p class="text-xs text-muted-foreground mt-1">
							<code class="text-[10px]">/workspaces/{w.slug}</code>
						</p>
					</CardHeader>
					<CardContent class="pt-0 text-[11px] text-muted-foreground space-y-1">
						<div>Role · <span class="font-mono uppercase">{w.role}</span></div>
						<div>Created {new Date(w.createdAt).toLocaleDateString()}</div>
					</CardContent>
				</button>
				{#if w.role === 'ADMIN'}
					<CardContent class="pt-0 pb-3">
						<Button
							variant="ghost"
							size="sm"
							class="h-6 text-[11px]"
							onclick={(e) => {
								e.stopPropagation();
								renameTarget = w;
								renameDraft = w.displayName;
							}}
						>
							<Pencil class="size-3" /> Rename
						</Button>
					</CardContent>
				{/if}
			</Card>
		{/each}
	</div>
{/snippet}

{#snippet empty()}
	<div class="flex flex-col items-center justify-center text-center py-16 space-y-4">
		<div class="size-20 rounded-full bg-primary/10 flex items-center justify-center mb-2">
			<Briefcase class="size-10 text-primary" />
		</div>
		<h2 class="text-xl font-semibold">No workspaces yet</h2>
		<p class="text-muted-foreground max-w-md">
			Workspaces scope agents, sessions, environments, vaults, and files to a
			team or project. You always have at least one — contact your admin if
			nothing shows up here.
		</p>
		<Button onclick={() => (createOpen = true)} size="lg">
			<Plus class="size-4 mr-1" /> Create your first workspace
		</Button>
	</div>
{/snippet}

<Dialog.Root bind:open={createOpen}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Create workspace</Dialog.Title>
			<Dialog.Description>
				Workspaces are independent scopes — agents, sessions, and vaults from one
				workspace don't cross into another. You'll be added as the admin.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-2 py-2">
			<Label for="new-workspace-name">Name</Label>
			<Input
				id="new-workspace-name"
				placeholder="e.g. Research sandbox"
				bind:value={createName}
			/>
			<p class="text-[10px] text-muted-foreground">
				A URL slug (e.g. <code>research-sandbox-ab12cd34</code>) is generated
				automatically from the name.
			</p>
		</div>
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
			<Button disabled={!createName.trim() || creating} onclick={createWorkspace}>
				<Plus class="size-4" />
				{creating ? 'Creating…' : 'Create workspace'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root
	open={renameTarget !== null}
	onOpenChange={(open) => !open && (renameTarget = null)}
>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Rename workspace</Dialog.Title>
			<Dialog.Description>
				The URL slug stays the same — renaming only changes the display name
				shown in the sidebar switcher and workspace list.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-2 py-2">
			<Label for="rename-workspace">Display name</Label>
			<Input id="rename-workspace" bind:value={renameDraft} />
			{#if renameTarget}
				<p class="text-[10px] text-muted-foreground">
					URL slug: <code>{renameTarget.slug}</code> (immutable)
				</p>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => (renameTarget = null)}>Cancel</Button>
			<Button disabled={!renameDraft.trim() || renaming} onclick={applyRename}>
				<Pencil class="size-4" />
				{renaming ? 'Saving…' : 'Save'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

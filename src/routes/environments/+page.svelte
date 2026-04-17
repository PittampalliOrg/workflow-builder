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
	import { Copy, Plus, Sparkles, Trash2 } from 'lucide-svelte';
	import ResourceListShell from '$lib/components/console/resource-list-shell.svelte';
	import type { EnvironmentSummary } from '$lib/types/environments';

	let environments = $state<EnvironmentSummary[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let search = $state('');
	let toDelete = $state<EnvironmentSummary | null>(null);
	let busyId = $state<string | null>(null);

	let filtered = $derived.by(() => {
		const q = search.trim().toLowerCase();
		if (!q) return environments;
		return environments.filter((e) => {
			const hay = `${e.name} ${e.slug} ${e.description ?? ''}`.toLowerCase();
			return hay.includes(q);
		});
	});

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch('/api/v1/environments');
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

	onMount(load);
</script>

<ResourceListShell
	title="Environments"
	subtitle="Configuration template for containers, such as sessions or code execution."
	itemLabel="environment"
	itemCount={environments.length}
	onSearch={(v) => (search = v)}
	primaryLabel="Add environment"
	onPrimary={() => goto('/environments/new')}
	{loading}
	{errorMessage}
	isEmpty={environments.length === 0 || filtered.length === 0}
	{content}
	{empty}
	{actions}
/>

{#snippet content()}
	<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
		{#each filtered as env (env.id)}
			<Card class="group relative hover:shadow-md transition-shadow cursor-pointer">
				<div class="absolute right-3 top-3 hidden group-hover:flex gap-1 z-10">
					<Button
						variant="ghost"
						size="icon"
						class="size-7"
						onclick={(e) => {
							e.stopPropagation();
							duplicate(env);
						}}
						disabled={busyId === env.id}
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
							toDelete = env;
						}}
						disabled={busyId === env.id}
						title="Archive"
					>
						<Trash2 class="size-3.5" />
					</Button>
				</div>
				<button
					type="button"
					class="text-left w-full h-full"
					onclick={() => goto(`/environments/${env.id}`)}
				>
					<CardHeader>
						<div class="flex items-center gap-2">
							<div
								class="size-10 rounded bg-primary/10 flex items-center justify-center text-xl"
							>
								{env.avatar ?? '🧱'}
							</div>
							<div class="flex-1 min-w-0">
								<CardTitle class="truncate text-base">{env.name}</CardTitle>
								<CardDescription class="truncate text-xs">
									{env.slug}
								</CardDescription>
							</div>
						</div>
					</CardHeader>
					<CardContent class="space-y-3">
						<p class="text-xs text-muted-foreground line-clamp-2 min-h-[2.4em]">
							{env.description ?? 'No description'}
						</p>
						<div class="flex items-center gap-2 flex-wrap">
							{#if env.sandboxTemplate}
								<Badge variant="outline" class="font-mono text-[10px]">
									{env.sandboxTemplate}
								</Badge>
							{/if}
							{#if env.networkingType}
								<Badge variant="secondary" class="text-[10px]">
									{env.networkingType}
								</Badge>
							{/if}
							<Badge variant="outline" class="text-[10px]">
								v{env.currentVersion ?? '—'}
							</Badge>
						</div>
					</CardContent>
				</button>
			</Card>
		{/each}
	</div>
{/snippet}

{#snippet actions()}
	<Button variant="outline" onclick={() => goto('/environments/new')}>
		<Sparkles class="size-4" /> From template
	</Button>
{/snippet}

{#snippet empty()}
	{#if environments.length === 0}
		<div class="flex flex-col items-center justify-center text-center py-16">
			<div
				class="size-20 rounded-full bg-primary/10 flex items-center justify-center text-4xl mb-4"
			>
				🧱
			</div>
			<h2 class="text-xl font-semibold mb-2">Create your first environment</h2>
			<p class="text-muted-foreground mb-6 max-w-md">
				Environments bundle a sandbox template, networking policy, and package list. Agents
				reference environments so the same config can drive many agents.
			</p>
			<Button onclick={() => goto('/environments/new')} size="lg">
				<Plus class="size-4 mr-1" /> Start from a template
			</Button>
		</div>
	{:else}
		<div class="text-center text-muted-foreground py-12">No environments match your search.</div>
	{/if}
{/snippet}

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

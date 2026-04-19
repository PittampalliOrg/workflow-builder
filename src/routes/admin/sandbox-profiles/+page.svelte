<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		Dialog,
		DialogContent,
		DialogDescription,
		DialogFooter,
		DialogHeader,
		DialogTitle,
		DialogTrigger
	} from '$lib/components/ui/dialog';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { formatDistanceToNow } from 'date-fns';
	import { Plus, Package, Clock, CircleCheck, CircleAlert, Wrench, Boxes } from 'lucide-svelte';
	import type {
		SandboxProfile,
		SandboxProfileBuildStatus
	} from '$lib/types/sandbox-profiles';
	import { PROFILE_SLUG_REGEX } from '$lib/types/sandbox-profiles';

	let profiles = $state<SandboxProfile[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let showArchived = $state(false);
	let creating = $state(false);
	let newProfile = $state<{ slug: string; name: string; description: string }>({
		slug: '',
		name: '',
		description: ''
	});
	let createError = $state<string | null>(null);

	const filtered = $derived(
		profiles.filter((p) => showArchived || !p.isArchived)
	);

	async function load() {
		loading = true;
		try {
			const res = await fetch('/api/v1/sandbox-profiles?includeArchived=true');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const body = (await res.json()) as { profiles: SandboxProfile[] };
			profiles = body.profiles ?? [];
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	async function createProfile() {
		createError = null;
		const slug = newProfile.slug.trim().toLowerCase();
		const name = newProfile.name.trim();
		if (!PROFILE_SLUG_REGEX.test(slug)) {
			createError = 'Slug must be lowercase alphanumerics and dashes.';
			return;
		}
		if (!name) {
			createError = 'Name is required.';
			return;
		}
		const res = await fetch('/api/v1/sandbox-profiles', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				slug,
				name,
				description: newProfile.description.trim() || null,
				packages: {}
			})
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			createError = body.message ?? `HTTP ${res.status}`;
			return;
		}
		const body = (await res.json()) as { profile: SandboxProfile };
		creating = false;
		newProfile = { slug: '', name: '', description: '' };
		goto(`/admin/sandbox-profiles/${body.profile.id}`);
	}

	function statusBadge(status: SandboxProfileBuildStatus) {
		if (status === 'built') return { color: 'bg-green-500/15 text-green-400', icon: CircleCheck, label: 'Built' };
		if (status === 'building') return { color: 'bg-blue-500/15 text-blue-400', icon: Clock, label: 'Building' };
		if (status === 'failed') return { color: 'bg-red-500/15 text-red-400', icon: CircleAlert, label: 'Failed' };
		return { color: 'bg-muted text-muted-foreground', icon: Wrench, label: 'Never built' };
	}

	function packageCount(p: SandboxProfile): number {
		return Object.values(p.packages ?? {}).reduce((s, v) => s + (v?.length ?? 0), 0);
	}

	onMount(load);
</script>

<div class="flex flex-col h-screen">
	<header class="border-b p-4 flex items-center justify-between gap-4">
		<div>
			<h1 class="text-xl font-semibold flex items-center gap-2">
				<Boxes size={20} /> Sandbox profiles
			</h1>
			<p class="text-sm text-muted-foreground mt-1">
				Pre-built image catalog. Environments pick a profile; the image is baked
				with the declared package manifest at build time.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<label class="flex items-center gap-2 text-xs text-muted-foreground">
				<input type="checkbox" bind:checked={showArchived} class="accent-primary" />
				Show archived
			</label>
			<Dialog bind:open={creating}>
				<DialogTrigger>
					{#snippet child({ props })}
						<Button {...props}>
							<Plus size={14} /> New profile
						</Button>
					{/snippet}
				</DialogTrigger>
				<DialogContent class="max-w-md">
					<DialogHeader>
						<DialogTitle>New sandbox profile</DialogTitle>
						<DialogDescription>
							Create an empty profile. Add packages + build from the detail page.
						</DialogDescription>
					</DialogHeader>
					<div class="space-y-3">
						<div>
							<label class="text-xs font-medium text-muted-foreground" for="new-name">Name</label>
							<Input
								id="new-name"
								placeholder="Manim animation profile"
								bind:value={newProfile.name}
							/>
						</div>
						<div>
							<label class="text-xs font-medium text-muted-foreground" for="new-slug">Slug</label>
							<Input
								id="new-slug"
								placeholder="manim-animation"
								bind:value={newProfile.slug}
							/>
							<p class="text-[11px] text-muted-foreground mt-1">
								Lowercase alphanumerics and dashes. Becomes the image tag suffix.
							</p>
						</div>
						<div>
							<label
								class="text-xs font-medium text-muted-foreground"
								for="new-description"
							>
								Description
							</label>
							<Textarea
								id="new-description"
								rows={3}
								bind:value={newProfile.description}
							/>
						</div>
						{#if createError}
							<p class="text-xs text-destructive">{createError}</p>
						{/if}
					</div>
					<DialogFooter>
						<Button variant="ghost" onclick={() => (creating = false)}>Cancel</Button>
						<Button onclick={createProfile}>Create</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	</header>

	<div class="flex-1 overflow-auto p-4">
		{#if loading}
			<div class="space-y-2">
				<Skeleton class="h-14" />
				<Skeleton class="h-14" />
				<Skeleton class="h-14" />
			</div>
		{:else if error}
			<div class="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm">
				Failed to load profiles: {error}
			</div>
		{:else if filtered.length === 0}
			<div class="text-center p-8 text-muted-foreground">
				<Package class="mx-auto mb-2" size={24} />
				No sandbox profiles yet. Click "New profile" to create one.
			</div>
		{:else}
			<div class="rounded border overflow-hidden">
				<table class="w-full text-sm">
					<thead class="bg-muted/50">
						<tr class="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
							<th class="px-4 py-2.5 font-medium">Name</th>
							<th class="px-4 py-2.5 font-medium">Slug</th>
							<th class="px-4 py-2.5 font-medium">Base</th>
							<th class="px-4 py-2.5 font-medium">Packages</th>
							<th class="px-4 py-2.5 font-medium">Status</th>
							<th class="px-4 py-2.5 font-medium">Used by</th>
							<th class="px-4 py-2.5 font-medium">Updated</th>
						</tr>
					</thead>
					<tbody class="divide-y">
						{#each filtered as p (p.id)}
							{@const sb = statusBadge(p.lastBuild.status)}
							{@const SbIcon = sb.icon}
							<tr
								class="cursor-pointer hover:bg-muted/30"
								onclick={() => goto(`/admin/sandbox-profiles/${p.id}`)}
							>
								<td class="px-4 py-3">
									<div class="flex items-center gap-2">
										<span class="font-medium">{p.name}</span>
										{#if p.isBuiltin}
											<Badge variant="outline" class="text-[10px]">built-in</Badge>
										{/if}
										{#if p.isArchived}
											<Badge variant="outline" class="text-[10px] opacity-60">archived</Badge>
										{/if}
									</div>
									{#if p.description}
										<p class="text-xs text-muted-foreground line-clamp-1 mt-0.5">
											{p.description}
										</p>
									{/if}
								</td>
								<td class="px-4 py-3 text-xs font-mono text-muted-foreground">
									{p.slug}
								</td>
								<td class="px-4 py-3 text-xs text-muted-foreground">
									{p.baseProfileSlug ?? '—'}
								</td>
								<td class="px-4 py-3 text-xs">
									{packageCount(p)} package{packageCount(p) === 1 ? '' : 's'}
								</td>
								<td class="px-4 py-3">
									<Badge variant="outline" class="text-[10px] {sb.color} border-transparent">
										<SbIcon size={10} class="mr-1 inline" />
										{sb.label}
									</Badge>
								</td>
								<td class="px-4 py-3 text-xs text-muted-foreground">
									{p.usedByCount ?? 0} env{(p.usedByCount ?? 0) === 1 ? '' : 's'}
								</td>
								<td class="px-4 py-3 text-xs text-muted-foreground">
									{formatDistanceToNow(new Date(p.updatedAt), { addSuffix: true })}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>

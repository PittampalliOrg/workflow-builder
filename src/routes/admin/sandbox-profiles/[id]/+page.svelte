<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { formatDistanceToNow } from 'date-fns';
	import {
		ArrowLeft,
		Save,
		Hammer,
		Plus,
		X,
		CircleCheck,
		CircleAlert,
		Clock,
		Wrench
	} from 'lucide-svelte';
	import type {
		SandboxProfile,
		SandboxProfileBuildStatus,
		SandboxProfilePackages
	} from '$lib/types/sandbox-profiles';
	import { PACKAGE_MANAGERS, type PackageManager } from '$lib/types/environments';

	const profileId = $derived(page.params.id as string);

	let profile = $state<SandboxProfile | null>(null);
	let dockerfile = $state<string>('');
	let loading = $state(true);
	let saving = $state(false);
	let building = $state(false);
	let err = $state<string | null>(null);
	let dirty = $state(false);

	// Edit state — we track local copies so the user can revert.
	let editedName = $state('');
	let editedDescription = $state('');
	let editedBaseSlug = $state<string | null>(null);
	let editedPackages = $state<SandboxProfilePackages>({});
	let editedCapabilities = $state<string[]>([]);
	let newCapability = $state('');

	// Row editor: one pending row per manager so the user can add before saving.
	let newManager = $state<PackageManager>('pip');
	let newSpec = $state('');

	let otherProfiles = $state<SandboxProfile[]>([]);

	async function load() {
		loading = true;
		err = null;
		try {
			const [a, all, preview] = await Promise.all([
				fetch(`/api/v1/sandbox-profiles/${profileId}`).then((r) => r.json()),
				fetch('/api/v1/sandbox-profiles?includeArchived=false').then((r) => r.json()),
				fetch(`/api/v1/sandbox-profiles/${profileId}/dockerfile-preview`)
					.then((r) => r.json())
					.catch(() => ({ dockerfile: '' }))
			]);
			if (a.message) {
				err = a.message;
				return;
			}
			// Clone from the raw fetch payload BEFORE assigning to reactive
			// state — structuredClone can't traverse Svelte's reactive
			// proxies, so cloning `profile!.packages` after `profile = a.profile`
			// throws `Failed to execute 'structuredClone' on 'Window': #<Object>
			// could not be cloned.` Mirrors the pattern in the env + agent
			// detail pages which clone from `a.environment.config` /
			// `a.agent.config` directly.
			const fresh = a.profile as SandboxProfile;
			editedName = fresh.name;
			editedDescription = fresh.description ?? '';
			editedBaseSlug = fresh.baseProfileSlug;
			editedPackages = structuredClone(fresh.packages ?? {});
			editedCapabilities = [...(fresh.capabilities ?? [])];
			profile = fresh;
			otherProfiles = ((all.profiles as SandboxProfile[]) ?? []).filter(
				(p) => p.id !== profileId && !p.baseProfileSlug // 1-level only
			);
			dockerfile = preview.dockerfile ?? '';
			dirty = false;
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	function markDirty() {
		dirty = true;
	}

	function addPackage() {
		const spec = newSpec.trim();
		if (!spec) return;
		const manager = newManager;
		const existing = editedPackages[manager] ?? [];
		if (existing.includes(spec)) return;
		editedPackages = {
			...editedPackages,
			[manager]: [...existing, spec]
		};
		newSpec = '';
		markDirty();
	}

	function removePackage(manager: PackageManager, spec: string) {
		editedPackages = {
			...editedPackages,
			[manager]: (editedPackages[manager] ?? []).filter((s) => s !== spec)
		};
		markDirty();
	}

	function addCapability() {
		const c = newCapability.trim().toLowerCase();
		if (!c) return;
		if (editedCapabilities.includes(c)) return;
		editedCapabilities = [...editedCapabilities, c];
		newCapability = '';
		markDirty();
	}

	function removeCapability(c: string) {
		editedCapabilities = editedCapabilities.filter((x) => x !== c);
		markDirty();
	}

	async function save() {
		saving = true;
		err = null;
		try {
			const res = await fetch(`/api/v1/sandbox-profiles/${profileId}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: editedName.trim(),
					description: editedDescription.trim() || null,
					baseProfileSlug: editedBaseSlug,
					packages: editedPackages,
					capabilities: editedCapabilities
				})
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				err = body.message ?? `HTTP ${res.status}`;
				return;
			}
			await load();
		} finally {
			saving = false;
		}
	}

	async function build() {
		building = true;
		err = null;
		try {
			const res = await fetch(`/api/v1/sandbox-profiles/${profileId}/build`, {
				method: 'POST'
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				err = body.message ?? `HTTP ${res.status}`;
				return;
			}
			await load();
		} finally {
			building = false;
		}
	}

	function statusMeta(status: SandboxProfileBuildStatus) {
		if (status === 'built')
			return { color: 'bg-green-500/15 text-green-400', Icon: CircleCheck, label: 'Built' };
		if (status === 'building')
			return { color: 'bg-blue-500/15 text-blue-400', Icon: Clock, label: 'Building' };
		if (status === 'failed')
			return { color: 'bg-red-500/15 text-red-400', Icon: CircleAlert, label: 'Failed' };
		return { color: 'bg-muted text-muted-foreground', Icon: Wrench, label: 'Never built' };
	}

	onMount(load);
</script>

<div class="flex flex-col h-screen">
	<header class="border-b p-3 flex items-center gap-3">
		<Button variant="ghost" size="sm" onclick={() => goto('/admin/sandbox-profiles')}>
			<ArrowLeft size={14} /> Profiles
		</Button>
		<div class="flex-1 min-w-0">
			{#if profile}
				<div class="flex items-center gap-2">
					<h1 class="text-lg font-semibold">{profile.name}</h1>
					{#if profile.isBuiltin}
						<Badge variant="outline" class="text-[10px]">built-in</Badge>
					{/if}
					{#if dirty}
						<span class="text-[10px] text-amber-500">unsaved</span>
					{/if}
				</div>
				<p class="text-xs text-muted-foreground font-mono">{profile.slug}</p>
			{/if}
		</div>
		<div class="flex items-center gap-2">
			{#if profile}
				{@const sm = statusMeta(profile.lastBuild.status)}
				<Badge variant="outline" class="text-[10px] {sm.color} border-transparent">
					<sm.Icon size={10} class="mr-1 inline" />
					{sm.label}
				</Badge>
				<Button variant="outline" onclick={build} disabled={building || saving}>
					<Hammer size={14} />
					{building ? 'Building…' : 'Build'}
				</Button>
				<Button onclick={save} disabled={!dirty || saving || building}>
					<Save size={14} />
					{saving ? 'Saving…' : 'Save'}
				</Button>
			{/if}
		</div>
	</header>

	<div class="flex-1 overflow-auto">
		{#if err}
			<div class="m-3 rounded border border-destructive/40 bg-destructive/5 p-3 text-sm">
				{err}
			</div>
		{/if}

		{#if loading || !profile}
			<div class="p-6 space-y-4">
				<Skeleton class="h-16" />
				<Skeleton class="h-40" />
			</div>
		{:else}
			<div class="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-0">
				<!-- Left: editor -->
				<div class="p-6 space-y-6 border-r">
					<!-- Basics -->
					<section class="space-y-3">
						<h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
							Basics
						</h2>
						<div>
							<Label>Name</Label>
							<Input bind:value={editedName} oninput={markDirty} />
						</div>
						<div>
							<Label>Description</Label>
							<Textarea rows={3} bind:value={editedDescription} oninput={markDirty} />
						</div>
						<div>
							<Label>Base profile</Label>
							<select
								class="h-9 w-full rounded border bg-background px-2 text-sm"
								bind:value={editedBaseSlug}
								onchange={markDirty}
							>
								<option value={null}>(root openshell-sandbox)</option>
								{#each otherProfiles as p}
									<option value={p.slug}>{p.name} ({p.slug})</option>
								{/each}
							</select>
							<p class="text-[11px] text-muted-foreground mt-1">
								Only root profiles are eligible as a base (1-level inheritance).
							</p>
						</div>
					</section>

					<!-- Packages -->
					<section class="space-y-3">
						<h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
							Packages
						</h2>
						<p class="text-xs text-muted-foreground">
							Installed at image build time. Layers run in order apt → cargo → gem
							→ go → npm → pip.
						</p>
						<div class="flex gap-2">
							<select
								class="h-9 w-24 shrink-0 rounded border bg-background px-2 text-sm"
								bind:value={newManager}
							>
								{#each PACKAGE_MANAGERS as m}
									<option value={m}>{m}</option>
								{/each}
							</select>
							<Input
								placeholder="package package==1.0.0"
								bind:value={newSpec}
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										addPackage();
									}
								}}
							/>
							<Button onclick={addPackage} disabled={!newSpec.trim()}>
								<Plus size={14} /> Add
							</Button>
						</div>
						<div class="space-y-1.5">
							{#each PACKAGE_MANAGERS as m}
								{@const specs = editedPackages[m] ?? []}
								{#each specs as spec (m + ':' + spec)}
									<div class="flex items-center gap-2 rounded border px-3 py-2 text-sm">
										<Badge variant="outline" class="w-14 justify-center font-mono text-[10px]">
											{m}
										</Badge>
										<span class="flex-1 font-mono text-xs">{spec}</span>
										<button
											type="button"
											aria-label="Remove"
											class="text-muted-foreground hover:text-destructive"
											onclick={() => removePackage(m, spec)}
										>
											<X size={14} />
										</button>
									</div>
								{/each}
							{/each}
							{#if Object.values(editedPackages).every((arr) => !arr || arr.length === 0)}
								<p class="text-xs text-muted-foreground">No packages declared.</p>
							{/if}
						</div>
					</section>

					<!-- Capabilities -->
					<section class="space-y-3">
						<h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
							Capabilities
						</h2>
						<p class="text-xs text-muted-foreground">
							Free-form tags surfaced to the sandbox-capability matcher. Lowercase only.
						</p>
						<div class="flex gap-2">
							<Input
								placeholder="manim"
								bind:value={newCapability}
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										addCapability();
									}
								}}
							/>
							<Button onclick={addCapability} disabled={!newCapability.trim()}>
								<Plus size={14} /> Add
							</Button>
						</div>
						<div class="flex flex-wrap gap-2">
							{#each editedCapabilities as c (c)}
								<span
									class="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs font-mono"
								>
									{c}
									<button
										type="button"
										aria-label="Remove"
										class="text-muted-foreground hover:text-destructive"
										onclick={() => removeCapability(c)}
									>
										<X size={12} />
									</button>
								</span>
							{/each}
							{#if editedCapabilities.length === 0}
								<p class="text-xs text-muted-foreground">No capabilities.</p>
							{/if}
						</div>
					</section>

					<!-- Build info -->
					<section class="space-y-3">
						<h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
							Build
						</h2>
						<dl class="grid grid-cols-[140px_1fr] gap-y-1.5 text-xs">
							<dt class="text-muted-foreground">Image tag</dt>
							<dd class="font-mono">{profile.imageTag ?? '—'}</dd>
							<dt class="text-muted-foreground">Dockerfile path</dt>
							<dd class="font-mono">{profile.dockerfilePath ?? '—'}</dd>
							<dt class="text-muted-foreground">Last build SHA</dt>
							<dd class="font-mono">{profile.lastBuild.sha ?? '—'}</dd>
							<dt class="text-muted-foreground">Last build</dt>
							<dd>
								{profile.lastBuild.at
									? formatDistanceToNow(new Date(profile.lastBuild.at), {
											addSuffix: true
										})
									: '—'}
							</dd>
							<dt class="text-muted-foreground">Last error</dt>
							<dd class="text-destructive whitespace-pre-wrap">
								{profile.lastBuild.error ?? '—'}
							</dd>
						</dl>
					</section>
				</div>

				<!-- Right: Dockerfile preview -->
				<div class="p-6">
					<h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
						Generated Dockerfile
					</h2>
					<p class="text-xs text-muted-foreground mb-3">
						What the server commits when you click Build. Updates when you save
						changes to the package list.
					</p>
					<pre
						class="rounded border bg-muted/30 p-3 text-[11px] font-mono whitespace-pre-wrap overflow-auto max-h-[70vh]">{dockerfile ||
							'(no Dockerfile — profile has no declared packages, reuses base image directly)'}</pre>
				</div>
			</div>
		{/if}
	</div>
</div>

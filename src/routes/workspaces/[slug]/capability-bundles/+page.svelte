<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import { Loader2, Package, Plus, RefreshCw, Save, Trash2 } from '@lucide/svelte';
	import AgentToolsIntegrations from '$lib/components/agents/tools-integrations/AgentToolsIntegrations.svelte';
	import AgentSkillsPicker from '$lib/components/agents/agent-skills-picker.svelte';
	import type { CapabilityBundleConfig } from '$lib/types/agents';

	type BundleSummary = {
		id: string;
		slug: string;
		name: string;
		description: string | null;
		tags: string[];
		currentVersion: number | null;
		isArchived: boolean;
	};
	type BundleDetail = BundleSummary & { config: CapabilityBundleConfig };
	type Draft = { id?: string; name: string; description: string; config: CapabilityBundleConfig };

	let bundles = $state<BundleSummary[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let draft = $state<Draft | null>(null);
	let saving = $state(false);

	onMount(() => void load());

	async function load() {
		loading = true;
		error = null;
		try {
			const res = await fetch('/api/capability-bundles');
			if (!res.ok) throw new Error(`Failed to load (${res.status})`);
			bundles = ((await res.json()) as { bundles: BundleSummary[] }).bundles ?? [];
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function newBundle() {
		draft = {
			name: 'Untitled bundle',
			description: '',
			config: { mcpServers: [], skills: [], tools: [], builtinTools: [] }
		};
	}

	async function edit(id: string) {
		error = null;
		try {
			const res = await fetch(`/api/capability-bundles/${id}`);
			if (!res.ok) throw new Error(`Failed to load bundle (${res.status})`);
			const b = ((await res.json()) as { bundle: BundleDetail }).bundle;
			draft = {
				id: b.id,
				name: b.name,
				description: b.description ?? '',
				config: {
					mcpServers: b.config.mcpServers ?? [],
					skills: b.config.skills ?? [],
					tools: b.config.tools ?? [],
					builtinTools: b.config.builtinTools ?? [],
					hooks: b.config.hooks,
					plugins: b.config.plugins,
					staticPromptPresetRefs: b.config.staticPromptPresetRefs,
					dynamicPromptPresetRefs: b.config.dynamicPromptPresetRefs
				}
			};
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	async function save() {
		if (!draft) return;
		saving = true;
		error = null;
		try {
			const body = JSON.stringify({
				name: draft.name,
				description: draft.description || null,
				config: draft.config
			});
			const res = draft.id
				? await fetch(`/api/capability-bundles/${draft.id}`, { method: 'PUT', body })
				: await fetch('/api/capability-bundles', { method: 'POST', body });
			if (!res.ok) throw new Error(`Save failed (${res.status})`);
			draft = null;
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function archive(id: string) {
		error = null;
		try {
			const res = await fetch(`/api/capability-bundles/${id}`, { method: 'DELETE' });
			if (!res.ok) throw new Error(`Archive failed (${res.status})`);
			if (draft?.id === id) draft = null;
			await load();
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
	}

	function csvUpdate(key: 'tools' | 'builtinTools', csv: string) {
		if (!draft) return;
		draft.config[key] = csv
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	function summaryLine(b: BundleSummary): string {
		return [b.currentVersion ? `v${b.currentVersion}` : 'draft', b.slug].join(' · ');
	}
</script>

<div class="mx-auto max-w-5xl space-y-4 p-4">
	<div class="flex items-center justify-between gap-2">
		<div>
			<h1 class="flex items-center gap-2 text-xl font-semibold">
				<Package class="size-5" /> Capability bundles
			</h1>
			<p class="text-sm text-muted-foreground">
				Reusable sets of MCP servers, skills and tools. Attach a bundle to any agent's
				Capabilities tab; it merges into the agent at runtime (the agent's own config wins).
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Button variant="outline" size="sm" onclick={() => void load()}>
				{#if loading}<Loader2 class="size-3 animate-spin" />{:else}<RefreshCw class="size-3" />{/if}
				Refresh
			</Button>
			<Button size="sm" onclick={newBundle}><Plus class="size-4" /> New bundle</Button>
		</div>
	</div>

	{#if error}<div class="rounded border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">{error}</div>{/if}

	<div class="grid gap-4 md:grid-cols-[20rem_1fr]">
		<!-- list -->
		<div class="space-y-2">
			{#if bundles.length === 0}
				<div class="rounded border border-dashed p-4 text-center text-sm text-muted-foreground">
					No bundles yet. Create one to share capabilities across agents.
				</div>
			{:else}
				{#each bundles as b (b.id)}
					<button
						type="button"
						class="w-full rounded border p-3 text-left hover:bg-muted/40 {draft?.id === b.id ? 'border-primary' : ''}"
						onclick={() => void edit(b.id)}
					>
						<div class="flex items-center justify-between gap-2">
							<span class="truncate font-medium text-sm">{b.name}</span>
							{#if b.isArchived}<Badge variant="destructive">archived</Badge>{/if}
						</div>
						<div class="text-[11px] text-muted-foreground">{summaryLine(b)}</div>
						{#if b.description}<p class="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{b.description}</p>{/if}
					</button>
				{/each}
			{/if}
		</div>

		<!-- editor -->
		<div>
			{#if !draft}
				<div class="rounded border border-dashed p-8 text-center text-sm text-muted-foreground">
					Select a bundle to edit, or create a new one.
				</div>
			{:else}
				<div class="space-y-4 rounded border p-4">
					<div class="flex items-center justify-between gap-2">
						<h2 class="font-semibold">{draft.id ? 'Edit bundle' : 'New bundle'}</h2>
						<div class="flex items-center gap-2">
							{#if draft.id}
								<Button variant="ghost" size="sm" class="text-destructive" onclick={() => draft && archive(draft.id!)}>
									<Trash2 class="size-3" /> Archive
								</Button>
							{/if}
							<Button variant="ghost" size="sm" onclick={() => (draft = null)}>Cancel</Button>
							<Button size="sm" disabled={saving} onclick={() => void save()}>
								{#if saving}<Loader2 class="size-3 animate-spin" />{:else}<Save class="size-3" />{/if}
								Save{draft.id ? ' (new version)' : ''}
							</Button>
						</div>
					</div>

					<div class="space-y-1.5">
						<Label for="bundle-name">Name</Label>
						<Input id="bundle-name" bind:value={draft.name} />
					</div>
					<div class="space-y-1.5">
						<Label for="bundle-desc">Description</Label>
						<Textarea id="bundle-desc" rows={2} bind:value={draft.description} />
					</div>

					<div class="space-y-1.5">
						<Label class="text-sm font-semibold">MCP servers</Label>
						<AgentToolsIntegrations
							value={draft.config.mcpServers ?? []}
							connectionMode="explicit"
							vaultIds={[]}
							onModeChange={() => {}}
							onChange={(next) => draft && (draft.config.mcpServers = next)}
						/>
					</div>

					<div class="space-y-1.5">
						<Label class="text-sm font-semibold">Skills</Label>
						<AgentSkillsPicker
							value={draft.config.skills ?? []}
							onChange={(next) => draft && (draft.config.skills = next)}
						/>
					</div>

					<div class="grid gap-3 sm:grid-cols-2">
						<div class="space-y-1.5">
							<Label for="bundle-tools">Tools (comma-separated)</Label>
							<Input
								id="bundle-tools"
								value={(draft.config.tools ?? []).join(', ')}
								oninput={(e) => csvUpdate('tools', (e.target as HTMLInputElement).value)}
							/>
						</div>
						<div class="space-y-1.5">
							<Label for="bundle-builtin">Built-in tools (comma-separated)</Label>
							<Input
								id="bundle-builtin"
								value={(draft.config.builtinTools ?? []).join(', ')}
								oninput={(e) => csvUpdate('builtinTools', (e.target as HTMLInputElement).value)}
							/>
						</div>
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>

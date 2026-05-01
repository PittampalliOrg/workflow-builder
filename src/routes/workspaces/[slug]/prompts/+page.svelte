<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		BookText,
		FileText,
		Plus,
		Search,
		Sparkles
	} from '@lucide/svelte';
	import type { PromptPresetSummary } from '$lib/types/prompt-presets';

	const slug = $derived(page.params.slug);

	let presets = $state<PromptPresetSummary[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let createOpen = $state(false);
	let creatingPreset = $state(false);
	let createError = $state<string | null>(null);
	let createName = $state('');
	let createDescription = $state('');
	let createSystemPrompt = $state('');
	let searchTerm = $state('');

	const filteredPresets = $derived.by(() => {
		const q = searchTerm.trim().toLowerCase();
		if (!q) return presets;
		return presets.filter(
			(p) =>
				p.title.toLowerCase().includes(q) ||
				(p.description ?? '').toLowerCase().includes(q)
		);
	});

	onMount(loadPresets);

	async function loadPresets() {
		loading = true;
		loadError = null;
		try {
			const res = await fetch('/api/prompt-presets');
			if (!res.ok) {
				loadError = `Failed to load prompt presets (${res.status})`;
				return;
			}
			const data = (await res.json()) as { presets: PromptPresetSummary[] };
			presets = data.presets ?? [];
		} catch (err) {
			loadError = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function createPreset() {
		const name = createName.trim();
		if (!name) {
			createError = 'Name is required';
			return;
		}
		const systemPrompt = createSystemPrompt.trim();
		if (!systemPrompt) {
			createError = 'System prompt content is required';
			return;
		}
		creatingPreset = true;
		createError = null;
		try {
			const res = await fetch('/api/prompt-presets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name,
					description: createDescription.trim() || null,
					messages: [{ role: 'system', content: systemPrompt }],
					arguments: [],
					templateFormat: 'mustache'
				})
			});
			if (!res.ok) {
				createError = `Create failed (${res.status})`;
				return;
			}
			const data = (await res.json()) as { preset: PromptPresetSummary };
			createOpen = false;
			createName = '';
			createDescription = '';
			createSystemPrompt = '';
			await goto(`/workspaces/${slug}/prompts/${data.preset.id}`);
		} catch (err) {
			createError = err instanceof Error ? err.message : String(err);
		} finally {
			creatingPreset = false;
		}
	}

	function formatRelativeDate(iso: string): string {
		const then = new Date(iso).getTime();
		const now = Date.now();
		const diff = Math.max(0, now - then);
		const day = 86_400_000;
		if (diff < 60_000) return 'just now';
		if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < day) return `${Math.floor(diff / 3_600_000)}h ago`;
		if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
		return new Date(iso).toLocaleDateString();
	}

	function presetCharCount(preset: PromptPresetSummary): number {
		const sys = (preset.latestVersion?.messages ?? []).find(
			(m) => m.role === 'system'
		);
		return (sys?.content ?? '').trim().length;
	}
</script>

<svelte:head>
	<title>Prompts · {slug}</title>
</svelte:head>

<div class="container mx-auto max-w-6xl space-y-4 p-4 lg:p-6">
	<div class="flex items-start justify-between gap-4">
		<div>
			<h1 class="text-2xl font-semibold">Prompts</h1>
			<p class="text-sm text-muted-foreground">
				Reusable prompt presets you can bind into any agent's prompt stack as a static
				prefix or dynamic tail block. Edit a preset and bound agents pick it up on
				their next republish.
			</p>
		</div>
		<Dialog.Root bind:open={createOpen}>
			<Dialog.Trigger>
				{#snippet child({ props })}
					<Button {...props} size="sm">
						<Plus class="size-4" /> New preset
					</Button>
				{/snippet}
			</Dialog.Trigger>
			<Dialog.Content class="max-w-2xl">
				<Dialog.Header>
					<Dialog.Title>Create prompt preset</Dialog.Title>
					<Dialog.Description>
						A reusable system-prompt block. Bind it to one or more agents from their
						Prompt tab.
					</Dialog.Description>
				</Dialog.Header>
				<div class="space-y-3 py-2">
					{#if createError}
						<Alert>
							<AlertDescription>{createError}</AlertDescription>
						</Alert>
					{/if}
					<div>
						<Label for="create-name">Name</Label>
						<Input
							id="create-name"
							bind:value={createName}
							placeholder="e.g. Code Review Style Guide"
						/>
					</div>
					<div>
						<Label for="create-description">Description</Label>
						<Textarea
							id="create-description"
							rows={2}
							bind:value={createDescription}
							placeholder="Short description (optional)"
						/>
					</div>
					<div>
						<Label for="create-system">System prompt content</Label>
						<Textarea
							id="create-system"
							rows={8}
							bind:value={createSystemPrompt}
							placeholder="The reusable text. Mustache placeholders ({"{{variable}}"}) are supported."
							class="font-mono text-xs"
						/>
					</div>
				</div>
				<Dialog.Footer>
					<Button variant="ghost" onclick={() => (createOpen = false)}>Cancel</Button>
					<Button disabled={creatingPreset} onclick={createPreset}>
						<Plus class="size-4" />
						{creatingPreset ? 'Creating...' : 'Create preset'}
					</Button>
				</Dialog.Footer>
			</Dialog.Content>
		</Dialog.Root>
	</div>

	{#if loadError}
		<Alert>
			<AlertDescription>{loadError}</AlertDescription>
		</Alert>
	{/if}

	<div class="flex items-center gap-2">
		<div class="relative flex-1 max-w-sm">
			<Search class="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
			<Input
				bind:value={searchTerm}
				placeholder="Search presets..."
				class="pl-8"
			/>
		</div>
		<span class="text-xs text-muted-foreground">
			{filteredPresets.length} of {presets.length}
		</span>
	</div>

	{#if loading}
		<div class="rounded-md border p-12 text-center text-sm text-muted-foreground">
			Loading...
		</div>
	{:else if filteredPresets.length === 0 && presets.length === 0}
		<div class="rounded-md border bg-muted/20 p-12 text-center">
			<BookText class="mx-auto mb-3 size-10 text-muted-foreground/60" />
			<h3 class="mb-1 text-sm font-semibold">No prompt presets yet</h3>
			<p class="mb-4 text-xs text-muted-foreground">
				Presets let you write reusable system-prompt blocks once and bind them
				to multiple agents. Create your first one to get started.
			</p>
			<Button size="sm" onclick={() => (createOpen = true)}>
				<Plus class="size-4" /> Create preset
			</Button>
		</div>
	{:else if filteredPresets.length === 0}
		<div class="rounded-md border p-12 text-center text-sm text-muted-foreground">
			No matches for "{searchTerm}".
		</div>
	{:else}
		<div class="rounded-md border">
			<table class="w-full text-sm">
				<thead class="border-b bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
					<tr>
						<th class="px-4 py-2.5 text-left font-medium">Name</th>
						<th class="px-4 py-2.5 text-left font-medium">Description</th>
						<th class="px-4 py-2.5 text-right font-medium">Version</th>
						<th class="px-4 py-2.5 text-right font-medium">Size</th>
						<th class="px-4 py-2.5 text-right font-medium">Updated</th>
					</tr>
				</thead>
				<tbody>
					{#each filteredPresets as preset (preset.id)}
						<tr
							class="cursor-pointer border-b last:border-b-0 transition-colors hover:bg-muted/30"
							onclick={() => goto(`/workspaces/${slug}/prompts/${preset.id}`)}
						>
							<td class="px-4 py-3">
								<div class="flex items-center gap-2">
									<FileText class="size-4 shrink-0 text-muted-foreground" />
									<span class="font-medium">{preset.title}</span>
									{#if !preset.isEnabled}
										<Badge variant="outline" class="text-[10px]">archived</Badge>
									{/if}
								</div>
							</td>
							<td class="px-4 py-3 text-muted-foreground">
								<span class="line-clamp-1">
									{preset.description || '—'}
								</span>
							</td>
							<td class="px-4 py-3 text-right tabular-nums">
								v{preset.latestVersion?.version ?? preset.version}
							</td>
							<td class="px-4 py-3 text-right tabular-nums text-muted-foreground">
								{presetCharCount(preset)}ch
							</td>
							<td class="px-4 py-3 text-right text-xs text-muted-foreground">
								{formatRelativeDate(preset.updatedAt)}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			<Sparkles class="size-3" />
			Tip: bind a preset as a static prefix on an agent for it to be eligible
			for Anthropic prompt cache (≥4000ch combined static prefix).
		</div>
	{/if}
</div>

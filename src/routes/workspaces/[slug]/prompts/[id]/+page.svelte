<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Breadcrumb from '$lib/components/ui/breadcrumb';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		Archive,
		ArrowLeft,
		ChevronRight,
		FileText,
		Save,
		Sparkles,
		Users
	} from '@lucide/svelte';
	import PromptContentEditor from '$lib/components/agents/prompt-content-editor.svelte';
	import type { PromptPresetSummary, PromptPresetVersion, PromptTemplateMessage } from '$lib/types/prompt-presets';

	const slug = $derived(page.params.slug);
	const presetId = $derived(page.params.id);

	type AgentUsage = {
		id: string;
		slug: string;
		name: string;
		bindingKind: 'static' | 'dynamic';
		version: number;
		latestVersion: number;
		isStale: boolean;
	};

	let preset = $state<PromptPresetSummary | null>(null);
	let usages = $state<AgentUsage[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);
	let saving = $state(false);
	let archiving = $state(false);
	let saveError = $state<string | null>(null);
	let archiveOpen = $state(false);

	// Editable fields
	let nameField = $state('');
	let descriptionField = $state('');
	let systemPromptField = $state('');

	// Track baseline so we know when to bump version
	let baselineSystemPrompt = $state('');
	let baselineName = $state('');
	let baselineDescription = $state('');

	const dirty = $derived(
		nameField !== baselineName ||
			descriptionField !== baselineDescription ||
			systemPromptField !== baselineSystemPrompt
	);
	const contentChanged = $derived(systemPromptField !== baselineSystemPrompt);

	onMount(load);

	async function load() {
		loading = true;
		loadError = null;
		try {
			// /api/prompt-presets returns the full list; pick our row out.
			const res = await fetch('/api/prompt-presets');
			if (!res.ok) {
				loadError = `Failed to load preset (${res.status})`;
				return;
			}
			const data = (await res.json()) as { presets: PromptPresetSummary[] };
			const row = data.presets.find((p) => p.id === presetId);
			if (!row) {
				loadError = 'Preset not found';
				return;
			}
			preset = row;
			nameField = row.title;
			descriptionField = row.description ?? '';
			const sys = row.latestVersion?.messages?.find((m) => m.role === 'system');
			systemPromptField = sys?.content ?? '';
			baselineName = nameField;
			baselineDescription = descriptionField;
			baselineSystemPrompt = systemPromptField;
		} catch (err) {
			loadError = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}

		await loadUsages();
	}

	async function loadUsages() {
		try {
			const res = await fetch(`/api/prompt-presets/${presetId}/usages`);
			if (res.ok) {
				const data = (await res.json()) as { usages: AgentUsage[] };
				usages = data.usages ?? [];
			}
		} catch {
			// Best-effort — usages don't gate the editor
		}
	}

	async function save() {
		if (!preset || !dirty) return;
		saving = true;
		saveError = null;
		try {
			const messages: PromptTemplateMessage[] = [
				{ role: 'system', content: systemPromptField }
			];
			const res = await fetch(`/api/prompt-presets/${preset.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: nameField.trim(),
					description: descriptionField.trim() || null,
					messages,
					arguments: preset.latestVersion?.arguments ?? [],
					templateFormat: 'mustache'
				})
			});
			if (!res.ok) {
				saveError = `Save failed (${res.status})`;
				return;
			}
			const data = (await res.json()) as { preset: PromptPresetSummary };
			preset = data.preset;
			baselineName = nameField;
			baselineDescription = descriptionField;
			baselineSystemPrompt = systemPromptField;
			await loadUsages();
		} catch (err) {
			saveError = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function archive() {
		if (!preset) return;
		archiving = true;
		try {
			const res = await fetch(`/api/prompt-presets/${preset.id}`, {
				method: 'DELETE'
			});
			if (res.ok) {
				archiveOpen = false;
				await goto(`/workspaces/${slug}/prompts`);
			} else {
				saveError = `Archive failed (${res.status})`;
			}
		} catch (err) {
			saveError = err instanceof Error ? err.message : String(err);
		} finally {
			archiving = false;
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
</script>

<svelte:head>
	<title>{preset?.title ?? 'Preset'} · Prompts · {slug}</title>
</svelte:head>

<div class="h-full overflow-y-auto">
	<div class="container mx-auto max-w-6xl space-y-4 p-4 lg:p-6">
	<Breadcrumb.Root>
		<Breadcrumb.List>
			<Breadcrumb.Item>
				<Breadcrumb.Link href="/workspaces/{slug}/prompts">Prompts</Breadcrumb.Link>
			</Breadcrumb.Item>
			<Breadcrumb.Separator>
				<ChevronRight class="size-3.5" />
			</Breadcrumb.Separator>
			<Breadcrumb.Item>
				<Breadcrumb.Page>{preset?.title ?? '...'}</Breadcrumb.Page>
			</Breadcrumb.Item>
		</Breadcrumb.List>
	</Breadcrumb.Root>

	{#if loadError}
		<Alert>
			<AlertDescription>{loadError}</AlertDescription>
		</Alert>
		<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/prompts`)}>
			<ArrowLeft class="size-4" /> Back to Prompts
		</Button>
	{:else if loading}
		<div class="rounded-md border p-12 text-center text-sm text-muted-foreground">
			Loading...
		</div>
	{:else if preset}
		<div class="flex items-start justify-between gap-4">
			<div class="flex items-start gap-3">
				<FileText class="mt-1 size-5 text-muted-foreground" />
				<div>
					<h1 class="text-2xl font-semibold">{preset.title}</h1>
					<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
						<Badge variant="outline" class="text-[10px]">
							v{preset.latestVersion?.version ?? preset.version}
						</Badge>
						<span>updated {formatRelativeDate(preset.updatedAt)}</span>
						{#if usages.length > 0}
							<span class="inline-flex items-center gap-1">
								<Users class="size-3" />
								used by {usages.length} agent{usages.length === 1 ? '' : 's'}
							</span>
						{/if}
						{#if !preset.isEnabled}
							<Badge variant="outline" class="text-[10px]">archived</Badge>
						{/if}
					</div>
				</div>
			</div>
			<div class="flex items-center gap-2">
				<Button
					variant="outline"
					size="sm"
					disabled={archiving}
					onclick={() => (archiveOpen = true)}
				>
					<Archive class="size-4" /> Archive
				</Button>
				<Button size="sm" disabled={!dirty || saving} onclick={save}>
					<Save class="size-4" />
					{saving ? 'Saving...' : contentChanged ? 'Save (new version)' : 'Save'}
				</Button>
			</div>
		</div>

		{#if saveError}
			<Alert>
				<AlertDescription>{saveError}</AlertDescription>
			</Alert>
		{/if}

		<div class="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
			<!-- Editor -->
			<div class="space-y-4">
				<div class="rounded-md border bg-background p-4">
					<div class="grid gap-3">
						<div>
							<Label for="preset-name">Name</Label>
							<Input id="preset-name" bind:value={nameField} />
						</div>
						<div>
							<Label for="preset-description">Description</Label>
							<Textarea
								id="preset-description"
								rows={2}
								bind:value={descriptionField}
								placeholder="Short description (optional)"
							/>
						</div>
					</div>
				</div>

				<div class="rounded-md border bg-background p-4">
					<div class="mb-2 flex items-center justify-between">
						<Label for="preset-system">System prompt content</Label>
						<span class="text-xs text-muted-foreground tabular-nums">
							{systemPromptField.length}ch
						</span>
					</div>
					<PromptContentEditor
						value={systemPromptField}
						onChange={(v) => (systemPromptField = v)}
						placeholder={'The reusable text. Mustache placeholders ({{variable}}) are supported.'}
						minHeight="60vh"
					/>
					<p class="mt-2 text-[11px] text-muted-foreground">
						This text becomes a section in any agent's prompt stack that binds this
						preset. Edits create a new version on save; agents stay pinned to their
						current version until they republish or bump.
					</p>
				</div>
			</div>

			<!-- Sidebar: usages + version -->
			<div class="space-y-4">
				<div class="rounded-md border bg-muted/20 p-4">
					<div class="mb-2 flex items-center gap-2 text-sm font-semibold">
						<Users class="size-4" /> Used by
					</div>
					{#if usages.length === 0}
						<p class="text-xs text-muted-foreground">
							No agents bind this preset yet. Open an agent's Prompt tab to bind it
							as a static prefix or dynamic tail block.
						</p>
					{:else}
						<ul class="space-y-1.5">
							{#each usages as usage}
								<li>
									<a
										href="/workspaces/{slug}/agents/{usage.id}"
										class="flex items-center justify-between gap-2 rounded-md border bg-background px-2 py-1.5 text-xs hover:bg-accent"
									>
										<span class="truncate font-medium">{usage.name}</span>
										<div class="flex items-center gap-1.5 text-[10px]">
											<Badge variant="outline" class="text-[10px]">
												{usage.bindingKind === 'static' ? 'prefix' : 'suffix'}
											</Badge>
											<span class="tabular-nums {usage.isStale ? 'text-amber-600' : 'text-muted-foreground'}">
												v{usage.version}{usage.isStale ? ` ↗` : ''}
											</span>
										</div>
									</a>
								</li>
							{/each}
						</ul>
						<p class="mt-2 text-[10px] text-muted-foreground">
							<Sparkles class="inline size-2.5" /> Stale agents are pinned to an older version. They'll keep their pinned content until republished.
						</p>
					{/if}
				</div>

				<div class="rounded-md border bg-muted/20 p-4">
					<div class="mb-2 text-sm font-semibold">Version</div>
					<div class="space-y-1 text-xs">
						<div class="flex justify-between">
							<span class="text-muted-foreground">Current</span>
							<span class="font-mono tabular-nums">
								v{preset.latestVersion?.version ?? preset.version}
							</span>
						</div>
						<div class="flex justify-between">
							<span class="text-muted-foreground">Hash</span>
							<code class="font-mono text-[10px] text-muted-foreground">
								{preset.latestVersion?.templateHash?.slice(0, 12) ?? '—'}
							</code>
						</div>
						<div class="flex justify-between">
							<span class="text-muted-foreground">Last edited</span>
							<span>{formatRelativeDate(preset.updatedAt)}</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	{/if}
	</div>
</div>

<Dialog.Root bind:open={archiveOpen}>
	<Dialog.Content>
		<Dialog.Header>
			<Dialog.Title>Archive this preset?</Dialog.Title>
			<Dialog.Description>
				Archived presets remain bound on existing agents (they keep their pinned
				version) but won't appear in pickers for new bindings. You can restore
				later by editing the row.
			</Dialog.Description>
		</Dialog.Header>
		<Dialog.Footer>
			<Button variant="ghost" onclick={() => (archiveOpen = false)}>Cancel</Button>
			<Button disabled={archiving} onclick={archive}>
				<Archive class="size-4" />
				{archiving ? 'Archiving...' : 'Archive'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Textarea } from '$lib/components/ui/textarea';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import type { AgentSkillRegistryEntry } from '$lib/agent-skill-presets';
	import {
		ArrowLeft,
		Check,
		ChevronDown,
		ChevronRight,
		Copy,
		ExternalLink,
		Pencil,
		Puzzle,
		Save,
		Trash2,
		X
	} from '@lucide/svelte';

	const slug = $derived((page.params.slug as string) ?? 'default');
	const skillId = $derived(page.params.id as string);

	let skill = $state<AgentSkillRegistryEntry | null>(null);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);

	// Edit state
	let editing = $state(false);
	let draftName = $state('');
	let draftDescription = $state('');
	let draftPrompt = $state('');
	let draftAllowedTools = $state('');
	let saving = $state(false);

	let promptCopied = $state(false);
	let toolsOpen = $state(true);

	async function load() {
		loading = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/agent-skills/${encodeURIComponent(skillId)}`);
			if (!res.ok) {
				errorMessage = `Failed to load skill (${res.status})`;
				return;
			}
			const data = (await res.json()) as { skill: AgentSkillRegistryEntry };
			skill = data.skill;
			draftName = skill.name;
			draftDescription = skill.description ?? '';
			draftPrompt = skill.prompt ?? '';
			draftAllowedTools = (skill.allowedTools ?? []).join(', ');
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function save() {
		if (!skill) return;
		saving = true;
		try {
			const res = await fetch(`/api/agent-skills/${encodeURIComponent(skill.id)}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					name: draftName.trim(),
					description: draftDescription.trim() || null,
					prompt: draftPrompt,
					allowedTools: draftAllowedTools
						.split(',')
						.map((t) => t.trim())
						.filter(Boolean)
				})
			});
			if (!res.ok) {
				errorMessage = `Save failed (${res.status}): ${(await res.text()).slice(0, 200)}`;
				return;
			}
			await load();
			editing = false;
		} finally {
			saving = false;
		}
	}

	async function deleteSkill() {
		if (!skill) return;
		if (!confirm(`Delete custom skill "${skill.name}"? This cannot be undone.`)) return;
		const res = await fetch(`/api/agent-skills/${encodeURIComponent(skill.id)}`, {
			method: 'DELETE'
		});
		if (!res.ok) {
			errorMessage = `Delete failed (${res.status})`;
			return;
		}
		goto(`/workspaces/${slug}/skills`);
	}

	async function copyPrompt() {
		if (!skill?.prompt) return;
		try {
			await navigator.clipboard.writeText(skill.prompt);
			promptCopied = true;
			setTimeout(() => (promptCopied = false), 1400);
		} catch {
			/* clipboard blocked */
		}
	}

	const isCustom = $derived(skill?.sourceType === 'custom');

	onMount(load);
</script>

<div class="flex h-full flex-col overflow-y-auto">
	<!-- Breadcrumb -->
	<div class="border-b bg-muted/30 px-4 py-1.5 flex items-center gap-2 text-xs text-muted-foreground">
		<a href="/workspaces/{slug}/skills" class="hover:text-foreground">Skills</a>
		<span class="text-muted-foreground/60">/</span>
		{#if skill}
			<CopyIdButton value={skill.id} />
		{:else}
			<span>Loading…</span>
		{/if}
	</div>

	{#if loading}
		<div class="space-y-3 p-6">
			<Skeleton class="h-8 w-80" />
			<Skeleton class="h-40" />
		</div>
	{:else if errorMessage}
		<div class="p-6">
			<Alert variant="destructive">
				<AlertDescription>{errorMessage}</AlertDescription>
			</Alert>
			<Button variant="outline" onclick={() => goto(`/workspaces/${slug}/skills`)} class="mt-4">
				<ArrowLeft class="size-4" /> Back to skills
			</Button>
		</div>
	{:else if skill}
		<!-- Title + status row -->
		<header class="border-b px-4 py-3 flex items-start justify-between gap-3 flex-wrap">
			<div class="min-w-0 flex-1 space-y-1">
				<div class="flex items-center gap-2 flex-wrap">
					{#if editing}
						<Input bind:value={draftName} class="h-8 max-w-md" />
					{:else}
						<h1 class="text-lg font-semibold tracking-tight">{skill.name}</h1>
					{/if}
					<Badge
						variant="outline"
						class="text-[10px] capitalize {skill.status === 'ENABLED'
							? 'bg-green-600/15 text-green-700 dark:text-green-400 border-transparent'
							: 'bg-muted'}"
					>
						{skill.status}
					</Badge>
					<Badge
						variant="outline"
						class="text-[10px] {isCustom
							? 'bg-indigo-500/15 text-indigo-300 border-transparent'
							: 'bg-blue-500/15 text-blue-300 border-transparent'}"
					>
						{isCustom ? 'custom' : 'registry'}
					</Badge>
					<Badge variant="outline" class="text-[10px]">
						v{skill.version ?? '1'}
					</Badge>
				</div>
				<p class="text-xs text-muted-foreground">
					<code class="text-[11px]">{skill.slug}</code>
					{#if skill.installSource}
						· <code class="text-[11px]">{skill.installSource}</code>
					{/if}
				</p>
			</div>
			<div class="flex items-center gap-2">
				{#if editing}
					<Button size="sm" variant="ghost" onclick={() => (editing = false)}>
						<X class="size-3.5" /> Cancel
					</Button>
					<Button size="sm" onclick={save} disabled={saving}>
						<Save class="size-3.5" /> {saving ? 'Saving…' : 'Save'}
					</Button>
				{:else if isCustom}
					<Button size="sm" variant="outline" onclick={() => (editing = true)}>
						<Pencil class="size-3.5" /> Edit
					</Button>
					<Button size="sm" variant="ghost" class="text-destructive" onclick={deleteSkill}>
						<Trash2 class="size-3.5" />
					</Button>
				{/if}
			</div>
		</header>

		<div class="mx-auto w-full max-w-3xl space-y-6 p-6">
			<!-- Description -->
			<section class="space-y-2">
				<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
					Description
				</h3>
				{#if editing}
					<Textarea bind:value={draftDescription} rows={2} />
				{:else if skill.description}
					<p class="text-sm">{skill.description}</p>
				{:else}
					<p class="text-xs text-muted-foreground">No description.</p>
				{/if}
			</section>

			<!-- When to use -->
			{#if skill.whenToUse}
				<section class="space-y-2">
					<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						When to use
					</h3>
					<p class="rounded border bg-muted/20 p-3 text-sm">{skill.whenToUse}</p>
				</section>
			{/if}

			<!-- Prompt body -->
			<section class="space-y-2">
				<div class="flex items-center justify-between">
					<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
						Prompt
					</h3>
					{#if !editing && skill.prompt}
						<Button variant="ghost" size="sm" class="h-6 gap-1 text-[11px]" onclick={copyPrompt}>
							{#if promptCopied}
								<Check class="size-3 text-green-500" /> Copied
							{:else}
								<Copy class="size-3" /> Copy
							{/if}
						</Button>
					{/if}
				</div>
				{#if editing}
					<Textarea bind:value={draftPrompt} rows={12} class="font-mono text-xs" />
				{:else if skill.prompt}
					<pre class="max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded border bg-muted/30 p-3 text-xs font-mono"><code
							>{skill.prompt}</code
						></pre>
				{:else}
					<p class="text-xs text-muted-foreground">No prompt body stored.</p>
				{/if}
			</section>

			<!-- Allowed tools -->
			<section class="space-y-2">
				<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
					Allowed tools
				</h3>
				{#if editing}
					<div class="space-y-1">
						<Label for="tools" class="text-xs text-muted-foreground">
							Comma-separated list. Leave empty to allow all tools.
						</Label>
						<Input id="tools" bind:value={draftAllowedTools} placeholder="Bash, Read, Grep" />
					</div>
				{:else if skill.allowedTools && skill.allowedTools.length > 0}
					<div class="flex flex-wrap gap-1.5">
						{#each skill.allowedTools as tool (tool)}
							<Badge variant="outline" class="text-[10px] font-mono">{tool}</Badge>
						{/each}
					</div>
				{:else}
					<p class="text-xs text-muted-foreground">
						No tool restrictions — skill has access to everything the agent can use.
					</p>
				{/if}
			</section>

			<!-- Source info -->
			<section class="space-y-2">
				<h3 class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
					Source
				</h3>
				<dl class="rounded border bg-muted/20 p-3 text-[11px] space-y-1.5">
					<div class="flex justify-between gap-3">
						<dt class="text-muted-foreground">Source type</dt>
						<dd class="font-mono">{skill.sourceType}</dd>
					</div>
					{#if skill.installSource}
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">Install source</dt>
							<dd class="font-mono truncate max-w-[360px]">{skill.installSource}</dd>
						</div>
					{/if}
					{#if skill.installAgent}
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">Install agent</dt>
							<dd class="font-mono">{skill.installAgent}</dd>
						</div>
					{/if}
					{#if skill.skillName}
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">Skill name</dt>
							<dd class="font-mono">{skill.skillName}</dd>
						</div>
					{/if}
					{#if skill.registryUrl}
						<div class="flex justify-between gap-3">
							<dt class="text-muted-foreground">Registry URL</dt>
							<dd>
								<a
									href={skill.registryUrl}
									target="_blank"
									rel="noreferrer"
									class="text-primary hover:underline inline-flex items-center gap-1"
								>
									<ExternalLink class="size-3" />
									skills.sh
								</a>
							</dd>
						</div>
					{/if}
				</dl>
			</section>
		</div>
	{/if}
</div>

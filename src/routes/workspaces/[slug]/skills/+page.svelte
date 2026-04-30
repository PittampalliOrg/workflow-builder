<script lang="ts">
	import { goto } from '$app/navigation';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Textarea } from '$lib/components/ui/textarea';
	import {
		Collapsible,
		CollapsibleContent,
		CollapsibleTrigger
	} from '$lib/components/ui/collapsible';
	import { Popover, PopoverContent, PopoverTrigger } from '$lib/components/ui/popover';
	import {
		ChevronDown,
		ChevronRight,
		CircleAlert,
		FileText,
		GitBranch,
		Pencil,
		Plus,
		Sparkles,
		Trash2,
		Upload,
		Users
	} from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { page } from '$app/state';

	const slug = $derived((page.params.slug as string) ?? 'default');

	type AgentSkill = {
		id?: string;
		registryId?: string;
		slug?: string;
		name: string;
		description?: string;
		whenToUse?: string;
		allowedTools?: string[];
		sourceType?: string;
		sourceRepo?: string;
		sourceRef?: string;
		skillPath?: string;
		registryUrl?: string;
		installSource?: string;
		skillName?: string;
		installAgent?: string;
		version?: string;
		status?: string;
		prompt?: string;
		projectId?: string | null;
		createdByUserId?: string | null;
		packageFilesCount?: number;
		packageFiles?: { path: string }[];
		usedByCount?: number;
	};

	type UsedByAgent = {
		id: string;
		slug: string;
		name: string;
		projectId: string | null;
		runtimeAppId: string | null;
		registryStatus: string | null;
	};

	let skills = $state<AgentSkill[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let importMessage = $state<string | null>(null);
	let canManage = $state(false);
	let expanded = $state<string | null>(null);
	let disabledOpen = $state(false);

	// Custom skill create/edit state.
	let customDialogOpen = $state(false);
	let customEditingId = $state<string | null>(null);
	let customName = $state('');
	let customDescription = $state('');
	let customPrompt = $state('');
	let customAllowedToolsText = $state('');
	let customSaving = $state(false);

	// GitHub import dialog state.
	let githubDialogOpen = $state(false);
	let githubRepo = $state('anthropics/skills');
	let githubSkillName = $state('');
	let githubRef = $state('main');
	let githubSaving = $state(false);

	// Zip import dialog state.
	let zipDialogOpen = $state(false);
	let zipFile = $state<File | null>(null);
	let zipSkillName = $state('');
	let zipSaving = $state(false);

	// Per-skill used-by popover cache so we don't refetch on every open.
	const usedByCache = $state(new Map<string, { agents: UsedByAgent[]; truncated: boolean }>());
	const usedByLoading = $state(new Set<string>());

	let enabledCount = $derived(skills.filter((s) => s.status === 'ENABLED').length);
	let customCount = $derived(skills.filter((s) => s.sourceType === 'custom').length);

	type SkillGroup = { label: string; status: string; skills: AgentSkill[] };
	let groups = $derived<SkillGroup[]>(
		(() => {
			const order = ['ENABLED', 'DRAFT', 'DISABLED'];
			const byStatus = new Map<string, AgentSkill[]>();
			for (const s of skills) {
				const k = (s.status || 'ENABLED').toUpperCase();
				if (!byStatus.has(k)) byStatus.set(k, []);
				byStatus.get(k)!.push(s);
			}
			return order
				.map((st) => ({
					label: st === 'ENABLED' ? 'Enabled' : st === 'DRAFT' ? 'Draft' : 'Disabled',
					status: st,
					skills: byStatus.get(st) ?? []
				}))
				.filter((g) => g.skills.length > 0);
		})()
	);

	function skillId(skill: AgentSkill): string {
		return skill.registryId || skill.id || skill.slug || skill.name;
	}

	async function loadSkills() {
		loading = true;
		errorMessage = null;
		try {
			const response = await fetch('/api/agent-skills?includeDisabled=true');
			if (!response.ok) {
				errorMessage = `Failed to load skills (${response.status})`;
				return;
			}
			const payload = await response.json();
			skills = Array.isArray(payload.skills) ? payload.skills : [];
			canManage = payload.canManage === true;
			// Invalidate the used-by cache — agent attachments may have shifted.
			usedByCache.clear();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load skills';
		} finally {
			loading = false;
		}
	}

	async function setStatus(skill: AgentSkill, enabled: boolean) {
		const id = encodeURIComponent(skillId(skill));
		const response = await fetch(`/api/admin/agent-skills/${id}/${enabled ? 'enable' : 'disable'}`, {
			method: 'POST'
		});
		if (!response.ok) {
			errorMessage = `Failed to ${enabled ? 'enable' : 'disable'} ${skill.name}`;
			return;
		}
		await loadSkills();
	}

	async function loadUsedBy(skill: AgentSkill) {
		const id = skillId(skill);
		if (usedByCache.has(id) || usedByLoading.has(id)) return;
		usedByLoading.add(id);
		try {
			const res = await fetch(`/api/agent-skills/${encodeURIComponent(id)}/used-by`);
			if (!res.ok) return;
			const payload = await res.json();
			usedByCache.set(id, {
				agents: Array.isArray(payload.agents) ? payload.agents : [],
				truncated: payload.truncated === true
			});
		} finally {
			usedByLoading.delete(id);
		}
	}

	function openCreateCustom() {
		customEditingId = null;
		customName = '';
		customDescription = '';
		customPrompt = '';
		customAllowedToolsText = '';
		customDialogOpen = true;
	}

	function openEditCustom(skill: AgentSkill) {
		customEditingId = skill.id ?? null;
		customName = skill.name;
		customDescription = skill.description ?? '';
		customPrompt = skill.prompt ?? '';
		customAllowedToolsText = (skill.allowedTools ?? []).join(', ');
		customDialogOpen = true;
	}

	async function saveCustomSkill() {
		if (!customName.trim() || !customPrompt.trim()) return;
		customSaving = true;
		errorMessage = null;
		try {
			const allowedTools = customAllowedToolsText
				.split(',')
				.map((t) => t.trim())
				.filter(Boolean);
			const body = {
				name: customName.trim(),
				description: customDescription.trim() || null,
				prompt: customPrompt,
				allowedTools
			};
			const url = customEditingId
				? `/api/agent-skills/${encodeURIComponent(customEditingId)}`
				: '/api/agent-skills';
			const method = customEditingId ? 'PATCH' : 'POST';
			const res = await fetch(url, {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				errorMessage = (await res.text()).slice(0, 200) || `Save failed (${res.status})`;
				return;
			}
			customDialogOpen = false;
			await loadSkills();
		} finally {
			customSaving = false;
		}
	}

	async function deleteCustomSkill(skill: AgentSkill) {
		if (!skill.id) return;
		if (!confirm(`Delete custom skill "${skill.name}"?`)) return;
		const res = await fetch(`/api/agent-skills/${encodeURIComponent(skill.id)}`, {
			method: 'DELETE'
		});
		if (!res.ok) {
			errorMessage = `Delete failed (${res.status})`;
			return;
		}
		await loadSkills();
	}

	function openGithubImport() {
		githubRepo = 'anthropics/skills';
		githubSkillName = '';
		githubRef = 'main';
		githubDialogOpen = true;
	}

	async function submitGithubImport() {
		const repo = githubRepo.trim();
		const skillName = githubSkillName.trim();
		if (!repo || !skillName) return;
		githubSaving = true;
		errorMessage = null;
		importMessage = null;
		try {
			const body: Record<string, unknown> = {
				installSource: repo,
				sourceRepo: repo,
				skillName,
				name: skillName,
				sourceRef: githubRef.trim() || 'main',
				status: 'ENABLED'
			};
			const res = await fetch('/api/admin/agent-skills/import', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!res.ok) {
				errorMessage = (await res.text()).slice(0, 300) || `Import failed (${res.status})`;
				return;
			}
			const payload = await res.json();
			const files = payload?.skill?.packageFilesCount ?? 0;
			importMessage = `Imported ${payload?.skill?.name || skillName} from ${repo}${files > 0 ? ` (${files} bundled files)` : ''}.`;
			githubDialogOpen = false;
			await loadSkills();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'GitHub import failed';
		} finally {
			githubSaving = false;
		}
	}

	function openZipImport() {
		zipFile = null;
		zipSkillName = '';
		zipDialogOpen = true;
	}

	function onZipFileSelected(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0] ?? null;
		zipFile = file;
		if (file && !zipSkillName.trim()) {
			zipSkillName = file.name.replace(/\.zip$/i, '').replace(/[^A-Za-z0-9._-]+/g, '-');
		}
	}

	async function submitZipImport() {
		if (!zipFile) return;
		const skillName = zipSkillName.trim();
		if (!skillName) return;
		zipSaving = true;
		errorMessage = null;
		importMessage = null;
		try {
			const form = new FormData();
			form.append('file', zipFile);
			form.append('skillName', skillName);
			form.append('status', 'ENABLED');
			const res = await fetch('/api/admin/agent-skills/import/zip', {
				method: 'POST',
				body: form
			});
			if (!res.ok) {
				errorMessage = (await res.text()).slice(0, 300) || `Zip import failed (${res.status})`;
				return;
			}
			const payload = await res.json();
			const files = payload?.skill?.packageFilesCount ?? 0;
			importMessage = `Uploaded ${payload?.skill?.name || skillName}${files > 0 ? ` (${files} bundled files)` : ''}.`;
			zipDialogOpen = false;
			await loadSkills();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Zip upload failed';
		} finally {
			zipSaving = false;
		}
	}

	onMount(() => {
		void loadSkills();
	});
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div>
			<h1 class="text-sm font-semibold tracking-tight">Skills library</h1>
			<p class="text-xs text-muted-foreground">
				Curated skills available to attach during agent creation.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Badge variant="outline">{enabledCount} enabled</Badge>
			{#if customCount > 0}
				<Badge variant="secondary">{customCount} custom</Badge>
			{/if}
			<Badge variant="outline">{skills.length} total</Badge>
			<Button variant="outline" size="sm" onclick={() => void loadSkills()}>
				{loading ? 'Loading' : 'Refresh'}
			</Button>
		</div>
	</header>

	<div class="flex-1 overflow-auto p-6">
		<div class="mx-auto flex max-w-5xl flex-col gap-4">
			{#if errorMessage}
				<Alert variant="destructive">
					<CircleAlert class="size-4" />
					<AlertDescription>{errorMessage}</AlertDescription>
				</Alert>
			{/if}

			{#if importMessage}
				<Alert>
					<AlertDescription>{importMessage}</AlertDescription>
				</Alert>
			{/if}

			<!-- Add toolbar -->
			<Card>
				<CardHeader>
					<CardTitle class="text-base">Add skills</CardTitle>
					<CardDescription>
						Fetch from a public GitHub repo, upload a local zip bundle, or draft a prompt-only
						skill from scratch. All three paths land in the same canonical registry + materialize
						bundled files into the sandbox at session start.
					</CardDescription>
				</CardHeader>
				<CardContent class="flex flex-wrap gap-2">
					<Button
						variant="outline"
						size="sm"
						disabled={!canManage}
						onclick={openGithubImport}
					>
						<GitBranch class="size-3" /> Import from GitHub
					</Button>
					<Button
						variant="outline"
						size="sm"
						disabled={!canManage}
						onclick={openZipImport}
					>
						<Upload class="size-3" /> Upload .zip
					</Button>
					<Button variant="outline" size="sm" onclick={openCreateCustom}>
						<Plus class="size-3" /> Draft custom skill
					</Button>
				</CardContent>
			</Card>

			{#if !canManage}
				<Alert>
					<AlertDescription>
						Read-only view — only platform admins or admins of the active workspace can add
						or toggle global skills. Custom-skill drafting is still available to workspace
						members.
					</AlertDescription>
				</Alert>
			{/if}

			{#if loading}
				<div class="py-16 text-center text-sm text-muted-foreground">Loading skills…</div>
			{:else if skills.length === 0}
				<div class="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
					No skills yet. Use the Add toolbar above to import or draft one.
				</div>
			{:else}
				{#each groups as group (group.status)}
					{@const isCollapsed = group.status === 'DISABLED'}
					{#if isCollapsed}
						<Collapsible bind:open={disabledOpen}>
							<CollapsibleTrigger class="flex w-full items-center gap-2 text-left text-sm font-semibold">
								{#if disabledOpen}
									<ChevronDown class="size-4" />
								{:else}
									<ChevronRight class="size-4" />
								{/if}
								<span>{group.label}</span>
								<Badge variant="outline">{group.skills.length}</Badge>
							</CollapsibleTrigger>
							<CollapsibleContent class="mt-2 space-y-3">
								{#each group.skills as skill (skillId(skill))}
									{@render skillCard(skill)}
								{/each}
							</CollapsibleContent>
						</Collapsible>
					{:else}
						<section class="space-y-3">
							<h2 class="flex items-center gap-2 text-sm font-semibold">
								<span>{group.label}</span>
								<Badge variant="outline">{group.skills.length}</Badge>
							</h2>
							{#each group.skills as skill (skillId(skill))}
								{@render skillCard(skill)}
							{/each}
						</section>
					{/if}
				{/each}
			{/if}
		</div>
	</div>
</div>

{#snippet skillCard(skill: AgentSkill)}
	{@const promptEmpty = !skill.prompt || !skill.prompt.trim()}
	{@const filesN = skill.packageFilesCount ?? 0}
	{@const usedN = skill.usedByCount ?? 0}
	<Card>
		<CardHeader>
			<div class="flex items-start justify-between gap-4">
				<button
					type="button"
					class="min-w-0 flex-1 text-left"
					onclick={() => (expanded = expanded === skillId(skill) ? null : skillId(skill))}
				>
					<div class="flex flex-wrap items-center gap-2">
						<CardTitle class="break-words text-base">{skill.name}</CardTitle>
						<Badge variant={skill.status === 'DISABLED' ? 'outline' : 'secondary'}>
							{skill.status || 'ENABLED'}
						</Badge>
						<Badge variant="outline">{skill.sourceType || 'registry'}</Badge>
						{#if filesN > 0}
							<Badge variant="outline" class="gap-1">
								<FileText class="size-3" /> {filesN} file{filesN === 1 ? '' : 's'}
							</Badge>
						{/if}
						{#if promptEmpty}
							<Badge variant="destructive">Empty prompt</Badge>
						{/if}
					</div>
					<CardDescription class="mt-2 break-words">
						{skill.description || 'No description'}
					</CardDescription>
				</button>
				<div class="flex items-center gap-1">
					<Popover
						onOpenChange={(open) => {
							if (open) void loadUsedBy(skill);
						}}
					>
						<PopoverTrigger>
							{#snippet child({ props }: { props: Record<string, unknown> })}
								<button
									{...props}
									type="button"
									class="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] hover:bg-muted {usedN === 0 ? 'text-muted-foreground' : ''}"
								>
									<Users class="size-3" />
									Used by {usedN}
								</button>
							{/snippet}
						</PopoverTrigger>
						<PopoverContent class="w-80 p-3">
							{@render usedByPopover(skill)}
						</PopoverContent>
					</Popover>
					<Button
						variant="ghost"
						size="sm"
						class="h-7 text-[11px]"
						onclick={() => goto(`/workspaces/${slug}/skills/${encodeURIComponent(skillId(skill))}`)}
					>
						View →
					</Button>
					{#if skill.sourceType === 'custom'}
						<Button variant="outline" size="sm" onclick={() => openEditCustom(skill)}>
							<Pencil class="size-3" /> Edit
						</Button>
						<Button variant="ghost" size="sm" onclick={() => void deleteCustomSkill(skill)}>
							<Trash2 class="size-3" />
						</Button>
					{:else}
						<Button
							variant="outline"
							size="sm"
							disabled={!canManage}
							onclick={() => setStatus(skill, skill.status === 'DISABLED')}
						>
							{skill.status === 'DISABLED' ? 'Enable' : 'Disable'}
						</Button>
					{/if}
				</div>
			</div>
		</CardHeader>
		{#if expanded === skillId(skill)}
			<CardContent class="space-y-3 text-sm">
				<div class="grid gap-2 md:grid-cols-2">
					<div>
						<p class="text-xs text-muted-foreground">Install source</p>
						<code class="break-all text-xs">{skill.installSource || skill.sourceRepo}</code>
					</div>
					<div>
						<p class="text-xs text-muted-foreground">Skill name</p>
						<code class="break-all text-xs">{skill.skillName || skill.name}</code>
					</div>
					<div>
						<p class="text-xs text-muted-foreground">Version</p>
						<span>{skill.version || 'latest'}</span>
					</div>
					<div>
						<p class="text-xs text-muted-foreground">Install agent</p>
						<span>{skill.installAgent || 'universal'}</span>
					</div>
				</div>
				{#if skill.registryUrl}
					<div>
						<p class="mb-1 text-xs text-muted-foreground">Registry URL</p>
						<a class="break-all text-xs text-primary underline" href={skill.registryUrl} target="_blank" rel="noreferrer">
							{skill.registryUrl}
						</a>
					</div>
				{/if}
				{#if filesN > 0 && skill.packageFiles}
					<div>
						<p class="mb-1 text-xs text-muted-foreground">
							Bundled files · materialized to <code>/sandbox/.workflow-builder/skills/&lt;instance&gt;/{skill.slug}/</code> at session start
						</p>
						<ul class="max-h-40 overflow-auto rounded border bg-muted p-2 text-xs">
							{#each skill.packageFiles as f (f.path)}
								<li class="font-mono break-all">{f.path}</li>
							{/each}
						</ul>
					</div>
				{/if}
				{#if !promptEmpty}
					<div>
						<p class="mb-1 text-xs text-muted-foreground">
							Prompt · {skill.prompt!.length.toLocaleString()} chars
						</p>
						<pre class="max-h-48 overflow-auto rounded border bg-muted p-2 text-xs whitespace-pre-wrap break-words">{skill.prompt!.slice(0, 800)}{skill.prompt!.length > 800 ? '\n…' : ''}</pre>
					</div>
				{:else}
					<Alert variant="destructive">
						<CircleAlert class="size-4" />
						<AlertDescription>
							This skill has no prompt body. Agents attach it but the LLM receives no
							skill-specific instructions — re-import to fetch SKILL.md content.
						</AlertDescription>
					</Alert>
				{/if}
			</CardContent>
		{/if}
	</Card>
{/snippet}

{#snippet usedByPopover(skill: AgentSkill)}
	{@const entry = usedByCache.get(skillId(skill))}
	{@const pending = usedByLoading.has(skillId(skill))}
	<div class="space-y-2 text-xs">
		<div class="flex items-center gap-2 font-semibold">
			<Users class="size-3" />
			Agents using {skill.name}
		</div>
		{#if pending && !entry}
			<p class="text-muted-foreground">Loading…</p>
		{:else if !entry || entry.agents.length === 0}
			<p class="text-muted-foreground">
				No agents currently attach this skill. Safe to disable or delete.
			</p>
		{:else}
			<ul class="space-y-1">
				{#each entry.agents as a (a.id)}
					<li>
						<button
							type="button"
							class="flex w-full items-center justify-between rounded border p-2 text-left hover:bg-muted"
							onclick={() => goto(`/workspaces/${slug}/agents/${encodeURIComponent(a.id)}`)}
						>
							<div class="min-w-0">
								<div class="truncate font-medium">{a.name}</div>
								<div class="truncate text-muted-foreground">{a.slug}</div>
							</div>
							<Badge variant={a.registryStatus === 'registered' ? 'secondary' : 'outline'}>
								{a.registryStatus || 'unregistered'}
							</Badge>
						</button>
					</li>
				{/each}
			</ul>
			{#if entry.truncated}
				<p class="text-muted-foreground">
					First 50 shown. Inspect agents in the Agents page to see all attachments.
				</p>
			{/if}
		{/if}
	</div>
{/snippet}

{#if customDialogOpen}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) customDialogOpen = false;
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') customDialogOpen = false;
		}}
		role="dialog"
		tabindex="-1"
	>
		<div class="w-full max-w-xl rounded-lg border bg-background p-5 shadow-lg space-y-4">
			<div>
				<h3 class="text-base font-semibold flex items-center gap-2">
					<Sparkles class="size-4" />
					{customEditingId ? 'Edit custom skill' : 'New custom skill'}
				</h3>
				<p class="text-xs text-muted-foreground mt-1">
					Custom skills live in <code>{slug}</code> and can be attached to agents in
					this workspace. The prompt is the skill body — agents load it verbatim.
					Each edit of the prompt bumps the version.
				</p>
			</div>

			<div class="space-y-1.5">
				<Label for="custom-name">Name</Label>
				<Input id="custom-name" bind:value={customName} placeholder="e.g. Code-review" />
			</div>

			<div class="space-y-1.5">
				<Label for="custom-desc">Description (optional)</Label>
				<Input
					id="custom-desc"
					bind:value={customDescription}
					placeholder="Short one-liner shown in the picker"
				/>
			</div>

			<div class="space-y-1.5">
				<Label for="custom-prompt">Prompt</Label>
				<Textarea
					id="custom-prompt"
					bind:value={customPrompt}
					placeholder="You are a senior code reviewer…"
					rows={8}
				/>
			</div>

			<div class="space-y-1.5">
				<Label for="custom-tools">Allowed tools (optional, comma-separated)</Label>
				<Input
					id="custom-tools"
					bind:value={customAllowedToolsText}
					placeholder="Bash, Read, Grep"
				/>
			</div>

			<div class="flex justify-end gap-2 pt-2">
				<Button variant="ghost" onclick={() => (customDialogOpen = false)}>Cancel</Button>
				<Button
					onclick={saveCustomSkill}
					disabled={!customName.trim() || !customPrompt.trim() || customSaving}
				>
					{customSaving ? 'Saving…' : customEditingId ? 'Save changes' : 'Create skill'}
				</Button>
			</div>
		</div>
	</div>
{/if}

{#if githubDialogOpen}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) githubDialogOpen = false;
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') githubDialogOpen = false;
		}}
		role="dialog"
		tabindex="-1"
	>
		<div class="w-full max-w-xl rounded-lg border bg-background p-5 shadow-lg space-y-4">
			<div>
				<h3 class="text-base font-semibold flex items-center gap-2">
					<GitBranch class="size-4" />
					Import from GitHub
				</h3>
				<p class="text-xs text-muted-foreground mt-1">
					Walks <code>skills/&lt;skillName&gt;/</code> in a public repo, fetches SKILL.md +
					co-located <code>scripts/</code> and <code>references/</code> files, and stores them
					in the registry. Caps: 80 files, 128 KiB per file, 2 MiB total.
				</p>
			</div>

			<div class="space-y-1.5">
				<Label for="gh-repo">Repository</Label>
				<Input id="gh-repo" bind:value={githubRepo} placeholder="anthropics/skills" />
			</div>

			<div class="space-y-1.5">
				<Label for="gh-skill-name">Skill name</Label>
				<Input id="gh-skill-name" bind:value={githubSkillName} placeholder="xlsx" />
				<p class="text-xs text-muted-foreground">
					Matches the directory under <code>skills/</code> in the repo.
				</p>
			</div>

			<div class="space-y-1.5">
				<Label for="gh-ref">Ref (branch, tag, or commit)</Label>
				<Input id="gh-ref" bind:value={githubRef} placeholder="main" />
			</div>

			<div class="flex justify-end gap-2 pt-2">
				<Button variant="ghost" onclick={() => (githubDialogOpen = false)}>Cancel</Button>
				<Button
					onclick={submitGithubImport}
					disabled={!githubRepo.trim() || !githubSkillName.trim() || githubSaving}
				>
					{githubSaving ? 'Importing…' : 'Import'}
				</Button>
			</div>
		</div>
	</div>
{/if}

{#if zipDialogOpen}
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		onclick={(e) => {
			if (e.target === e.currentTarget) zipDialogOpen = false;
		}}
		onkeydown={(e) => {
			if (e.key === 'Escape') zipDialogOpen = false;
		}}
		role="dialog"
		tabindex="-1"
	>
		<div class="w-full max-w-xl rounded-lg border bg-background p-5 shadow-lg space-y-4">
			<div>
				<h3 class="text-base font-semibold flex items-center gap-2">
					<Upload class="size-4" />
					Upload .zip
				</h3>
				<p class="text-xs text-muted-foreground mt-1">
					Zip should contain a top-level <code>&lt;skillName&gt;/SKILL.md</code> plus any
					<code>scripts/</code> or <code>references/</code> subdirectories. Same per-file
					and total caps as GitHub import. Request size capped at 4 MiB.
				</p>
			</div>

			<div class="space-y-1.5">
				<Label for="zip-file">Zip file</Label>
				<Input
					id="zip-file"
					type="file"
					accept=".zip,application/zip"
					onchange={onZipFileSelected}
				/>
				{#if zipFile}
					<p class="text-xs text-muted-foreground">
						{zipFile.name} · {(zipFile.size / 1024).toFixed(1)} KiB
					</p>
				{/if}
			</div>

			<div class="space-y-1.5">
				<Label for="zip-skill-name">Skill name</Label>
				<Input id="zip-skill-name" bind:value={zipSkillName} placeholder="crawl4ai" />
				<p class="text-xs text-muted-foreground">
					Must match the top-level directory inside the zip.
				</p>
			</div>

			<div class="flex justify-end gap-2 pt-2">
				<Button variant="ghost" onclick={() => (zipDialogOpen = false)}>Cancel</Button>
				<Button
					onclick={submitZipImport}
					disabled={!zipFile || !zipSkillName.trim() || zipSaving}
				>
					{zipSaving ? 'Uploading…' : 'Upload'}
				</Button>
			</div>
		</div>
	</div>
{/if}

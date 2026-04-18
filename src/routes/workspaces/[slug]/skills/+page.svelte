<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Textarea } from '$lib/components/ui/textarea';
	import { CircleAlert, Plus, Pencil, Trash2, Sparkles } from 'lucide-svelte';
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
		installs?: string;
		prompt?: string;
		projectId?: string | null;
		createdByUserId?: string | null;
	};

	let skills = $state<AgentSkill[]>([]);
	let searchResults = $state<AgentSkill[]>([]);
	let loading = $state(true);
	let searching = $state(false);
	let errorMessage = $state<string | null>(null);
	let importMessage = $state<string | null>(null);
	let importing = $state(false);
	let canManage = $state(false);
	let expanded = $state<string | null>(null);
	let searchQuery = $state('web design');

	// Custom skill create/edit state.
	let customDialogOpen = $state(false);
	let customEditingId = $state<string | null>(null);
	let customName = $state('');
	let customDescription = $state('');
	let customPrompt = $state('');
	let customAllowedToolsText = $state('');
	let customSaving = $state(false);

	let enabledCount = $derived(skills.filter((skill) => skill.status !== 'DISABLED').length);
	let customCount = $derived(skills.filter((skill) => skill.sourceType === 'custom').length);

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
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Failed to load skills';
		} finally {
			loading = false;
		}
	}

	async function searchSkillCatalog() {
		if (!searchQuery.trim()) {
			searchResults = [];
			return;
		}
		searching = true;
		errorMessage = null;
		try {
			const response = await fetch(`/api/agent-skills/search?q=${encodeURIComponent(searchQuery)}`);
			if (!response.ok) {
				const payload = await response.json().catch(() => null);
				errorMessage = payload?.error || `Search failed (${response.status})`;
				return;
			}
			const payload = await response.json();
			searchResults = Array.isArray(payload.skills) ? payload.skills : [];
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Search failed';
		} finally {
			searching = false;
		}
	}

	async function addSkill(skill: AgentSkill) {
		importing = true;
		errorMessage = null;
		importMessage = null;
		try {
			const body: Record<string, unknown> = {
				name: skill.name,
				description: skill.description,
				slug: skill.slug,
				installSource: skill.installSource || skill.sourceRepo,
				sourceRepo: skill.sourceRepo || skill.installSource,
				skillName: skill.skillName || skill.name,
				registryUrl: skill.registryUrl,
				version: skill.version || 'latest',
				status: 'ENABLED'
			};
			const response = await fetch('/api/admin/agent-skills/import', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (!response.ok) {
				const text = await response.text();
				errorMessage = text || `Import failed (${response.status})`;
				return;
			}
			const payload = await response.json();
			importMessage = `Added ${payload.skill?.name || 'skill'} to the catalog.`;
			await loadSkills();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Add failed';
		} finally {
			importing = false;
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

	onMount(() => {
		void loadSkills();
	});
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div>
			<h1 class="text-sm font-semibold tracking-tight">Skills</h1>
			<p class="text-xs text-muted-foreground">
				Metadata references for skills installed into each run sandbox.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Badge variant="outline">{enabledCount} enabled</Badge>
			{#if customCount > 0}
				<Badge variant="secondary">{customCount} custom</Badge>
			{/if}
			<Button variant="outline" size="sm" onclick={() => openCreateCustom()}>
				<Plus class="size-3" /> New custom skill
			</Button>
			<Button variant="outline" size="sm" onclick={() => void loadSkills()}>
				{loading ? 'Loading' : 'Refresh'}
			</Button>
		</div>
	</header>

	<div class="flex-1 overflow-auto p-6">
		<div class="mx-auto grid max-w-6xl gap-4 lg:grid-cols-[1fr_22rem]">
			<section class="space-y-4">
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

				{#if loading}
					<div class="py-16 text-center text-sm text-muted-foreground">Loading skills...</div>
				{:else if skills.length === 0}
					<div class="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
						No skills found.
					</div>
				{:else}
					<div class="grid gap-3">
						{#each skills as skill (skillId(skill))}
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
											</div>
											<CardDescription class="mt-2 break-words">
												{skill.description || 'No description'}
											</CardDescription>
										</button>
		{#if skill.sourceType === 'custom'}
			<div class="flex items-center gap-1">
				<Button
					variant="outline"
					size="sm"
					onclick={() => openEditCustom(skill)}
				>
					<Pencil class="size-3" /> Edit
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onclick={() => void deleteCustomSkill(skill)}
				>
					<Trash2 class="size-3" />
				</Button>
			</div>
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
									</CardContent>
								{/if}
							</Card>
						{/each}
					</div>
				{/if}
			</section>

			<aside class="space-y-4">
				<Card>
					<CardHeader>
						<CardTitle class="text-base">Find Skills</CardTitle>
						<CardDescription>
							Search skills.sh and add metadata references. Selected skills install at runtime with npx skills.
						</CardDescription>
					</CardHeader>
					<CardContent class="space-y-3">
						{#if !canManage}
							<Alert>
								<AlertDescription>
									Only platform admins or admins of the active project can add, enable, or
									disable global skills.
								</AlertDescription>
							</Alert>
						{/if}
						<div class="space-y-1.5">
							<Label for="skill-search">Search skills.sh</Label>
							<Input
								id="skill-search"
								bind:value={searchQuery}
								disabled={!canManage}
								onkeydown={(event) => {
									if (event.key === 'Enter') void searchSkillCatalog();
								}}
							/>
						</div>
						<Button class="w-full" onclick={() => void searchSkillCatalog()} disabled={searching || !canManage}>
							{searching ? 'Searching' : 'Search'}
						</Button>
						{#if searchResults.length > 0}
							<div class="space-y-2">
								{#each searchResults as skill (skillId(skill))}
									<div class="rounded-md border p-3 text-sm">
										<div class="flex items-start justify-between gap-3">
											<div class="min-w-0">
												<p class="truncate font-medium">{skill.name}</p>
												<p class="truncate text-xs text-muted-foreground">
													{skill.installSource || skill.sourceRepo}
													{#if skill.installs}
														· {skill.installs} installs
													{/if}
												</p>
											</div>
											<Button
												variant="outline"
												size="sm"
												disabled={importing || !canManage}
												onclick={() => void addSkill(skill)}
											>
												Add
											</Button>
										</div>
									</div>
								{/each}
							</div>
						{/if}
					</CardContent>
				</Card>
			</aside>
		</div>
	</div>
</div>

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

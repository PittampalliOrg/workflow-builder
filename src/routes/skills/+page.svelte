<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { CircleAlert } from 'lucide-svelte';
	import { onMount } from 'svelte';

	type AgentSkill = {
		id?: string;
		registryId?: string;
		slug?: string;
		name: string;
		description?: string;
		whenToUse?: string;
		prompt: string;
		allowedTools?: string[];
		arguments?: string[];
		argumentHint?: string;
		sourceType?: string;
		sourceRepo?: string;
		sourceRef?: string;
		skillPath?: string;
		version?: string;
		contentHash?: string;
		license?: string;
		status?: string;
		packageManifest?: Record<string, unknown>;
	};

	let skills = $state<AgentSkill[]>([]);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let importMessage = $state<string | null>(null);
	let importing = $state(false);
	let canManage = $state(false);
	let expanded = $state<string | null>(null);
	let sourceRepo = $state('https://github.com/vercel-labs/agent-skills');
	let sourceRef = $state('main');
	let skillPath = $state('skills/ai-sdk/SKILL.md');
	let skillMarkdown = $state('');

	let enabledCount = $derived(skills.filter((skill) => skill.status !== 'DISABLED').length);

	function skillId(skill: AgentSkill): string {
		return skill.registryId || skill.id || skill.slug || skill.name;
	}

	function packageFileCount(skill: AgentSkill): number {
		const files = skill.packageManifest?.files;
		return Array.isArray(files) ? files.length : 0;
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

	async function importSkill() {
		importing = true;
		errorMessage = null;
		importMessage = null;
		try {
			const body: Record<string, unknown> = {
				sourceRepo,
				sourceRef,
				skillPath,
				status: 'DRAFT'
			};
			if (skillMarkdown.trim()) body.skillMarkdown = skillMarkdown;
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
			importMessage = `Imported ${payload.skill?.name || 'skill'} as draft.`;
			skillMarkdown = '';
			await loadSkills();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : 'Import failed';
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

	onMount(() => {
		void loadSkills();
	});
</script>

<div class="flex h-full flex-col">
	<header class="flex h-12 items-center justify-between border-b border-border px-6">
		<div>
			<h1 class="text-sm font-semibold tracking-tight">Skills</h1>
			<p class="text-xs text-muted-foreground">
				Curated agent capabilities for profiles and workflow agent nodes.
			</p>
		</div>
		<div class="flex items-center gap-2">
			<Badge variant="outline">{enabledCount} enabled</Badge>
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
												{#if skill.sourceType}
													<Badge variant="outline">{skill.sourceType}</Badge>
												{/if}
											</div>
											<CardDescription class="mt-2 break-words">
												{skill.description || 'No description'}
											</CardDescription>
										</button>
		<Button
			variant="outline"
			size="sm"
			disabled={!canManage}
			onclick={() => setStatus(skill, skill.status === 'DISABLED')}
		>
											{skill.status === 'DISABLED' ? 'Enable' : 'Disable'}
										</Button>
									</div>
								</CardHeader>
								{#if expanded === skillId(skill)}
									<CardContent class="space-y-3 text-sm">
										<div class="grid gap-2 md:grid-cols-2">
											<div>
												<p class="text-xs text-muted-foreground">Source</p>
												<code class="break-all text-xs">{skill.sourceRepo || 'local curated'}</code>
											</div>
											<div>
												<p class="text-xs text-muted-foreground">Path</p>
												<code class="break-all text-xs">{skill.skillPath || 'SKILL.md'}</code>
											</div>
											<div>
												<p class="text-xs text-muted-foreground">Version</p>
												<span>{skill.version || '1'}</span>
											</div>
											<div>
												<p class="text-xs text-muted-foreground">Hash</p>
												<code class="break-all text-xs">{skill.contentHash || 'unversioned'}</code>
											</div>
											<div>
												<p class="text-xs text-muted-foreground">Package files</p>
												<span>{packageFileCount(skill)}</span>
											</div>
										</div>
										{#if skill.allowedTools && skill.allowedTools.length > 0}
											<div>
												<p class="mb-1 text-xs text-muted-foreground">Allowed tools</p>
												<div class="flex flex-wrap gap-1">
													{#each skill.allowedTools as tool}
														<Badge variant="outline">{tool}</Badge>
													{/each}
												</div>
											</div>
										{/if}
										<div>
											<p class="mb-1 text-xs text-muted-foreground">Prompt preview</p>
											<pre class="max-h-56 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap">{skill.prompt}</pre>
										</div>
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
						<CardTitle class="text-base">Import Skill</CardTitle>
						<CardDescription>
							Import an Agent Skills-compatible SKILL.md from an approved source. New imports start as draft.
						</CardDescription>
					</CardHeader>
					<CardContent class="space-y-3">
						{#if !canManage}
							<Alert>
								<AlertDescription>
									Only platform admins can import, enable, or disable global skills.
								</AlertDescription>
							</Alert>
						{/if}
						<div class="space-y-1.5">
							<Label for="skill-source-repo">Source repo</Label>
							<Input id="skill-source-repo" bind:value={sourceRepo} disabled={!canManage} />
						</div>
						<div class="grid grid-cols-2 gap-3">
							<div class="space-y-1.5">
								<Label for="skill-source-ref">Ref</Label>
								<Input id="skill-source-ref" bind:value={sourceRef} disabled={!canManage} />
							</div>
							<div class="space-y-1.5">
								<Label for="skill-source-path">Skill path</Label>
								<Input id="skill-source-path" bind:value={skillPath} disabled={!canManage} />
							</div>
						</div>
						<div class="space-y-1.5">
							<Label for="skill-markdown">SKILL.md override</Label>
							<Textarea
								id="skill-markdown"
								rows={8}
								bind:value={skillMarkdown}
								disabled={!canManage}
								placeholder={'---\nname: my-skill\ndescription: What it does\n---\nSkill instructions...'}
							/>
							<p class="text-[11px] text-muted-foreground">
								Paste SKILL.md here to test parsing without fetching from the source repo.
							</p>
						</div>
						<Button class="w-full" onclick={() => void importSkill()} disabled={importing || !canManage}>
							{importing ? 'Importing' : 'Import as Draft'}
						</Button>
					</CardContent>
				</Card>
			</aside>
		</div>
	</div>
</div>

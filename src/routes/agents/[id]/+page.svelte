<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Switch } from '$lib/components/ui/switch';
	import {
		Tabs,
		TabsContent,
		TabsList,
		TabsTrigger
	} from '$lib/components/ui/tabs';
	import {
		Collapsible,
		CollapsibleContent,
		CollapsibleTrigger
	} from '$lib/components/ui/collapsible';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import {
		Sheet,
		SheetContent,
		SheetHeader,
		SheetTitle,
		SheetTrigger
	} from '$lib/components/ui/sheet';
	import * as Dialog from '$lib/components/ui/dialog';
	import {
		Popover,
		PopoverContent,
		PopoverTrigger
	} from '$lib/components/ui/popover';
	import ApiSnippet from '$lib/components/console/api-snippet.svelte';
	import AgentTestPane from '$lib/components/agents/agent-test-pane.svelte';
	import AgentMcpPicker from '$lib/components/agents/agent-mcp-picker.svelte';
	import AgentSkillsPicker from '$lib/components/agents/agent-skills-picker.svelte';
	import AgentHooksEditor from '$lib/components/agents/agent-hooks-editor.svelte';
	import AgentVaultsPicker from '$lib/components/agents/agent-vaults-picker.svelte';
	import {
		ArrowLeft,
		ChevronDown,
		ChevronRight,
		Clock,
		Code2,
		ExternalLink,
		History,
		Play,
		Save,
		Download,
		GitFork,
		Rocket,
		Workflow
	} from 'lucide-svelte';
	import type {
		AgentDetail,
		AgentConfig,
		AgentVersionSummary
	} from '$lib/types/agents';
	import type { EnvironmentSummary } from '$lib/types/environments';

	const agentId = page.params.id as string;

	let agent = $state<AgentDetail | null>(null);
	let config = $state<AgentConfig | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let errorMessage = $state<string | null>(null);
	let dirty = $state(false);
	let publishOpen = $state(false);
	let publishChangelog = $state('');
	let publishing = $state(false);
	let forkOpen = $state(false);
	let forkName = $state('');
	let forkDescription = $state('');
	let forking = $state(false);
	let tab = $state<'basics' | 'capabilities' | 'sandbox' | 'advanced'>('basics');
	let usages = $state<Array<{ workflowId: string; workflowName: string; nodeIds: string[] }>>([]);
	let versions = $state<AgentVersionSummary[]>([]);
	let versionsOpen = $state(false);
	let environments = $state<EnvironmentSummary[]>([]);

	async function load() {
		loading = true;
		try {
			const [a, u, e] = await Promise.all([
				fetch(`/api/agents/${agentId}`).then((r) => r.json()),
				fetch(`/api/agents/${agentId}/usages`)
					.then((r) => r.json())
					.catch(() => ({ usages: [] })),
				fetch('/api/v1/environments')
					.then((r) => r.json())
					.catch(() => ({ environments: [] }))
			]);
			if (a.error) {
				errorMessage = a.error;
				return;
			}
			agent = a.agent;
			config = structuredClone(a.agent.config);
			usages = u.usages ?? [];
			environments = e.environments ?? [];
			dirty = false;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function loadVersions() {
		const res = await fetch(`/api/agents/${agentId}/versions`);
		if (res.ok) {
			const data = await res.json();
			versions = data.versions ?? [];
		}
	}

	async function saveAgent(changelog?: string) {
		if (!agent || !config) return false;
		errorMessage = null;
		const res = await fetch(`/api/agents/${agentId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: agent.name,
				description: agent.description,
				avatar: agent.avatar,
				tags: agent.tags,
				runtime: agent.runtime,
				environmentId: agent.environmentId,
				environmentVersion: agent.environmentVersion,
				defaultVaultIds: agent.defaultVaultIds,
				config,
				...(changelog ? { changelog } : {})
			})
		});
		if (!res.ok) {
			errorMessage = `Save failed (${res.status})`;
			return false;
		}
		const { agent: updated } = await res.json();
		agent = updated;
		config = structuredClone(updated.config);
		dirty = false;
		return true;
	}

	/** Save the in-flight edits as a draft — no changelog, silent new version. */
	async function save() {
		saving = true;
		try {
			await saveAgent();
		} finally {
			saving = false;
		}
	}

	/** Save + record an explicit changelog, surfacing the new version on the
	 * history sheet for team members. Opens a dialog to collect the note. */
	async function forkAgent() {
		if (!agent) return;
		if (forking) return;
		forking = true;
		try {
			const res = await fetch(`/api/agents/${agentId}/duplicate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: forkName.trim() || `${agent.name} (fork)`,
					description: forkDescription.trim() || agent.description
				})
			});
			if (!res.ok) {
				errorMessage = `Fork failed (${res.status})`;
				return;
			}
			const { agent: forked } = await res.json();
			forkOpen = false;
			forkName = '';
			forkDescription = '';
			if (forked?.id) goto(`/agents/${forked.id}`);
		} finally {
			forking = false;
		}
	}

	async function publishVersion() {
		if (!publishChangelog.trim()) return;
		publishing = true;
		try {
			const ok = await saveAgent(publishChangelog.trim());
			if (ok) {
				publishChangelog = '';
				publishOpen = false;
			}
		} finally {
			publishing = false;
		}
	}

	async function restore(version: number) {
		const res = await fetch(`/api/agents/${agentId}/versions/${version}`, {
			method: 'POST'
		});
		if (res.ok) {
			await load();
			versionsOpen = false;
		}
	}

	function markDirty() {
		dirty = true;
	}

	function updateConfig<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) {
		if (!config) return;
		config = { ...config, [key]: value };
		markDirty();
	}

	function toggleBuiltinTool(tool: string) {
		if (!config) return;
		const next = config.builtinTools.includes(tool)
			? config.builtinTools.filter((t) => t !== tool)
			: [...config.builtinTools, tool];
		updateConfig('builtinTools', next);
	}

	const BUILTIN_TOOLS = [
		'execute_command',
		'read_file',
		'write_file',
		'edit_file',
		'list_files',
		'grep_search'
	];

	onMount(load);
</script>

<svelte:window
	onkeydown={(e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 's') {
			e.preventDefault();
			save();
		}
	}}
/>

<div class="flex flex-col h-screen">
	<header class="border-b p-3 flex items-center gap-3 flex-wrap">
		<Button variant="ghost" size="sm" onclick={() => goto('/agents')}>
			<ArrowLeft class="size-4" />
		</Button>
		<div class="flex items-center gap-2 flex-1 min-w-0">
			<div class="size-8 rounded bg-primary/10 flex items-center justify-center text-base">
				{agent?.avatar ?? '🤖'}
			</div>
			<div class="flex-1 min-w-0">
				<Input
					class="border-0 shadow-none h-8 px-2 font-semibold text-base focus-visible:ring-1"
					value={agent?.name ?? ''}
					oninput={(e) => {
						if (agent) {
							agent = { ...agent, name: (e.target as HTMLInputElement).value };
							markDirty();
						}
					}}
				/>
				<div class="text-xs text-muted-foreground px-2">
					{agent?.slug ?? ''} · v{agent?.currentVersion ?? '—'}
					{#if dirty}
						<span class="text-amber-500">· unsaved</span>
					{/if}
				</div>
			</div>
		</div>
		<Sheet bind:open={versionsOpen}>
			<SheetTrigger>
				<Button variant="outline" size="sm" onclick={loadVersions}>
					<History class="size-4" /> History
				</Button>
			</SheetTrigger>
			<SheetContent class="w-[400px] sm:max-w-[400px]">
				<SheetHeader>
					<SheetTitle>Version history</SheetTitle>
				</SheetHeader>
				<div class="mt-4 space-y-2">
					{#each versions as v}
						<div class="flex items-center justify-between p-2 rounded border">
							<div>
								<div class="font-medium text-sm">v{v.version}</div>
								<div class="text-xs text-muted-foreground">
									<Clock class="inline size-3" />
									{new Date(v.createdAt).toLocaleString()}
								</div>
								{#if v.changelog}
									<div class="text-xs mt-1">{v.changelog}</div>
								{/if}
							</div>
							{#if v.version !== agent?.currentVersion}
								<Button size="sm" variant="outline" onclick={() => restore(v.version)}>
									Restore
								</Button>
							{:else}
								<Badge variant="secondary">current</Badge>
							{/if}
						</div>
					{/each}
					{#if versions.length === 0}
						<div class="text-sm text-muted-foreground py-8 text-center">
							No history yet. Save to create the first version.
						</div>
					{/if}
				</div>
			</SheetContent>
		</Sheet>
		<Popover>
			<PopoverTrigger>
				<Button variant="outline" size="sm" title="Show API snippet">
					<Code2 class="size-4" /> Code
				</Button>
			</PopoverTrigger>
			<PopoverContent class="w-[560px] p-3" align="end">
				<div class="text-xs font-semibold mb-1">Run this agent via the API</div>
				<p class="text-xs text-muted-foreground mb-2">
					Creates a session with this agent as the starting config.
				</p>
				<ApiSnippet
					curl={`curl -X POST $WORKFLOW_BUILDER_URL/api/v1/sessions \\\n  -H 'Authorization: Bearer $WB_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"agentId":"${agentId}","initialMessage":"Hello"}'`}
					python={`import requests\n\nres = requests.post(\n    f"{WORKFLOW_BUILDER_URL}/api/v1/sessions",\n    headers={"Authorization": f"Bearer {WB_API_KEY}"},\n    json={"agentId": "${agentId}", "initialMessage": "Hello"},\n)\nsession = res.json()["session"]\nprint(session["id"])`}
					typescript={`const res = await fetch(\`\${WORKFLOW_BUILDER_URL}/api/v1/sessions\`, {\n  method: 'POST',\n  headers: {\n    Authorization: \`Bearer \${WB_API_KEY}\`,\n    'Content-Type': 'application/json'\n  },\n  body: JSON.stringify({ agentId: '${agentId}', initialMessage: 'Hello' })\n});\nconst { session } = await res.json();\nconsole.log(session.id);`}
				/>
			</PopoverContent>
		</Popover>
		<Button
			variant="outline"
			size="sm"
			onclick={() => window.open(`/api/v1/agents/${agentId}/export`, '_blank')}
			title="Download as .md"
		>
			<Download class="size-4" /> Export
		</Button>
		<Dialog.Root bind:open={forkOpen}>
			<Dialog.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="outline" size="sm" title="Fork a new agent from this one">
						<GitFork class="size-4" /> Fork
					</Button>
				{/snippet}
			</Dialog.Trigger>
			<Dialog.Content class="max-w-lg">
				<Dialog.Header>
					<Dialog.Title>Fork this agent</Dialog.Title>
					<Dialog.Description>
						Creates a new agent seeded with the current config. The fork keeps
						a reference to its parent via <code>sourceTemplateSlug</code>;
						sessions already running on the original continue unaffected.
					</Dialog.Description>
				</Dialog.Header>
				<div class="space-y-3 py-2">
					<div>
						<Label for="fork-name">Name</Label>
						<Input
							id="fork-name"
							placeholder={agent ? `${agent.name} (fork)` : ''}
							bind:value={forkName}
						/>
					</div>
					<div>
						<Label for="fork-description">Description</Label>
						<Textarea
							id="fork-description"
							rows={2}
							placeholder={agent?.description ?? 'What is this fork for?'}
							bind:value={forkDescription}
						/>
					</div>
				</div>
				<Dialog.Footer>
					<Button variant="ghost" onclick={() => (forkOpen = false)}>Cancel</Button>
					<Button disabled={forking} onclick={forkAgent}>
						<GitFork class="size-4" />
						{forking ? 'Forking…' : 'Fork agent'}
					</Button>
				</Dialog.Footer>
			</Dialog.Content>
		</Dialog.Root>
		<Button variant="outline" disabled={!dirty || saving} onclick={save}>
			<Save class="size-4" />
			{saving ? 'Saving…' : 'Save draft'}
		</Button>
		<Dialog.Root bind:open={publishOpen}>
			<Dialog.Trigger>
				{#snippet child({ props })}
					<Button {...props}>
						<Rocket class="size-4" />
						Publish version
					</Button>
				{/snippet}
			</Dialog.Trigger>
			<Dialog.Content class="max-w-lg">
				<Dialog.Header>
					<Dialog.Title>Publish a new version</Dialog.Title>
					<Dialog.Description>
						Add a short note describing what changed. This version stays visible in the history
						tab and can be restored later. Sessions already running pin to their original
						version and won't be affected.
					</Dialog.Description>
				</Dialog.Header>
				<div class="space-y-2 py-2">
					<Label for="publish-changelog">Changelog</Label>
					<Textarea
						id="publish-changelog"
						rows={4}
						placeholder="e.g. Tightened the code-review instructions; added new MCP server."
						bind:value={publishChangelog}
					/>
				</div>
				<Dialog.Footer>
					<Button
						variant="ghost"
						onclick={() => {
							publishOpen = false;
							publishChangelog = '';
						}}
					>
						Cancel
					</Button>
					<Button
						disabled={!publishChangelog.trim() || publishing}
						onclick={publishVersion}
					>
						<Rocket class="size-4" />
						{publishing ? 'Publishing…' : 'Publish version'}
					</Button>
				</Dialog.Footer>
			</Dialog.Content>
		</Dialog.Root>
	</header>

	{#if errorMessage}
		<Alert variant="destructive" class="m-3">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	{#if loading || !agent || !config}
		<div class="p-6 space-y-4">
			<Skeleton class="h-16" />
			<Skeleton class="h-96" />
		</div>
	{:else}
		<div class="flex-1 grid grid-cols-1 lg:grid-cols-[2fr_1fr] overflow-hidden">
			<div class="overflow-y-auto p-6">
				<Tabs value={tab} onValueChange={(v) => (tab = v as typeof tab)}>
					<TabsList class="mb-4">
						<TabsTrigger value="basics">Basics</TabsTrigger>
						<TabsTrigger value="capabilities">Capabilities</TabsTrigger>
						<TabsTrigger value="sandbox">Sandbox</TabsTrigger>
						<TabsTrigger value="advanced">Advanced</TabsTrigger>
					</TabsList>

					<TabsContent value="basics" class="space-y-6">
						<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
							<div>
								<Label>Description</Label>
								<Textarea
									rows={2}
									value={agent.description ?? ''}
									oninput={(e) => {
										if (!agent) return;
										agent = {
											...agent,
											description: (e.target as HTMLTextAreaElement).value
										};
										markDirty();
									}}
								/>
							</div>
							<div>
								<Label>Avatar (emoji)</Label>
								<Input
									value={agent.avatar ?? ''}
									oninput={(e) => {
										if (!agent) return;
										agent = {
											...agent,
											avatar: (e.target as HTMLInputElement).value || null
										};
										markDirty();
									}}
								/>
							</div>
							<div class="md:col-span-2">
								<Label>Tags (comma-separated)</Label>
								<Input
									value={agent.tags.join(', ')}
									oninput={(e) => {
										if (!agent) return;
										agent = {
											...agent,
											tags: (e.target as HTMLInputElement).value
												.split(',')
												.map((t) => t.trim())
												.filter(Boolean)
										};
										markDirty();
									}}
								/>
							</div>
						</div>

						<div class="space-y-3 border-t pt-4">
							<h3 class="font-semibold text-sm">Environment</h3>
							<div class="flex items-center gap-2">
								<select
									class="flex-1 rounded-md border bg-background px-3 py-2 text-sm"
									value={agent.environmentId ?? ''}
									onchange={(e) => {
										if (!agent) return;
										const val = (e.target as HTMLSelectElement).value;
										const chosen = environments.find((env) => env.id === val);
										agent = {
											...agent,
											environmentId: val || null,
											environmentVersion: chosen?.currentVersion ?? null
										};
										markDirty();
									}}
								>
									<option value="">No environment (uses default sandbox)</option>
									{#each environments as env}
										<option value={env.id}>
											{env.avatar ?? '🧱'} {env.name} — v{env.currentVersion ?? '—'}
										</option>
									{/each}
								</select>
								{#if agent.environmentId}
									<a
										href="/environments/{agent.environmentId}"
										target="_blank"
										class="text-xs text-primary hover:underline flex items-center gap-1"
									>
										Edit <ExternalLink class="size-3" />
									</a>
								{:else}
									<a
										href="/environments/new"
										target="_blank"
										class="text-xs text-primary hover:underline"
									>
										+ New
									</a>
								{/if}
							</div>
							<p class="text-xs text-muted-foreground">
								Environments bundle sandbox template, networking, and packages. Reusable across
								agents.
							</p>
						</div>

						<div class="space-y-3">
							<h3 class="font-semibold text-sm">Model</h3>
							<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
								<div>
									<Label>Model spec</Label>
									<Input
										value={config.modelSpec ?? ''}
										placeholder="e.g. anthropic/claude-opus-4-7"
										oninput={(e) =>
											updateConfig(
												'modelSpec',
												(e.target as HTMLInputElement).value
											)}
									/>
								</div>
								<div>
									<Label>Temperature</Label>
									<Input
										type="number"
										step="0.1"
										min="0"
										max="2"
										value={config.temperature ?? 0.7}
										oninput={(e) => {
											const n = Number((e.target as HTMLInputElement).value);
											updateConfig('temperature', Number.isFinite(n) ? n : undefined);
										}}
									/>
								</div>
							</div>
						</div>

						<div class="space-y-3">
							<h3 class="font-semibold text-sm">Persona</h3>
							<div>
								<Label>Role</Label>
								<Input
									value={config.role ?? ''}
									placeholder="e.g. Senior Engineer"
									oninput={(e) =>
										updateConfig('role', (e.target as HTMLInputElement).value)}
								/>
							</div>
							<div>
								<Label>Goal</Label>
								<Input
									value={config.goal ?? ''}
									placeholder="e.g. Help me ship features"
									oninput={(e) =>
										updateConfig('goal', (e.target as HTMLInputElement).value)}
								/>
							</div>
							<div>
								<Label>System prompt</Label>
								<Textarea
									rows={6}
									value={config.systemPrompt ?? ''}
									oninput={(e) =>
										updateConfig(
											'systemPrompt',
											(e.target as HTMLTextAreaElement).value
										)}
								/>
							</div>
							<div>
								<Label>Instructions (one per line)</Label>
								<Textarea
									rows={4}
									value={(config.instructions ?? []).join('\n')}
									oninput={(e) => {
										const lines = (e.target as HTMLTextAreaElement).value
											.split('\n')
											.map((l) => l.trim())
											.filter(Boolean);
										updateConfig('instructions', lines);
									}}
								/>
							</div>
							<div>
								<Label>Style guidelines (one per line)</Label>
								<Textarea
									rows={3}
									placeholder="e.g. Use Markdown, cite file paths as file_path:line_number"
									value={(config.styleGuidelines ?? []).join('\n')}
									oninput={(e) => {
										const lines = (e.target as HTMLTextAreaElement).value
											.split('\n')
											.map((l) => l.trim())
											.filter(Boolean);
										updateConfig('styleGuidelines', lines);
									}}
								/>
							</div>
						</div>
					</TabsContent>

					<TabsContent value="capabilities" class="space-y-4">
						<Collapsible open={true}>
							<CollapsibleTrigger
								class="flex items-center gap-2 w-full text-left font-semibold text-sm py-2"
							>
								<ChevronDown class="size-4" /> Built-in tools ({config.builtinTools.length})
							</CollapsibleTrigger>
							<CollapsibleContent class="space-y-2 pl-6">
								<div class="flex flex-wrap gap-2">
									{#each BUILTIN_TOOLS as tool}
										<button
											type="button"
											class="px-2 py-1 rounded border text-xs {config.builtinTools.includes(tool)
												? 'bg-primary text-primary-foreground border-primary'
												: 'bg-muted hover:bg-muted/70'}"
											onclick={() => toggleBuiltinTool(tool)}
										>
											{tool}
										</button>
									{/each}
								</div>
							</CollapsibleContent>
						</Collapsible>

						<Collapsible>
							<CollapsibleTrigger
								class="flex items-center gap-2 w-full text-left font-semibold text-sm py-2"
							>
								<ChevronRight class="size-4" /> MCP servers ({config.mcpServers.length})
							</CollapsibleTrigger>
							<CollapsibleContent class="pl-6">
								<AgentMcpPicker
									value={config.mcpServers}
									connectionMode={config.mcpConnectionMode}
									vaultIds={agent.defaultVaultIds}
									onModeChange={(mode) => updateConfig('mcpConnectionMode', mode)}
									onChange={(next) => updateConfig('mcpServers', next)}
								/>
							</CollapsibleContent>
						</Collapsible>

						<Collapsible>
							<CollapsibleTrigger
								class="flex items-center gap-2 w-full text-left font-semibold text-sm py-2"
							>
								<ChevronRight class="size-4" /> Vaults ({agent.defaultVaultIds.length})
							</CollapsibleTrigger>
							<CollapsibleContent class="pl-6">
								<AgentVaultsPicker
									value={agent.defaultVaultIds}
									onChange={(next) => {
										if (!agent) return;
										agent = { ...agent, defaultVaultIds: next };
										markDirty();
									}}
								/>
							</CollapsibleContent>
						</Collapsible>

						<Collapsible>
							<CollapsibleTrigger
								class="flex items-center gap-2 w-full text-left font-semibold text-sm py-2"
							>
								<ChevronRight class="size-4" /> Skills ({config.skills.length})
							</CollapsibleTrigger>
							<CollapsibleContent class="pl-6">
								<AgentSkillsPicker
									value={config.skills}
									onChange={(next) => updateConfig('skills', next)}
								/>
							</CollapsibleContent>
						</Collapsible>

						<Collapsible>
							<CollapsibleTrigger
								class="flex items-center gap-2 w-full text-left font-semibold text-sm py-2"
							>
								<ChevronRight class="size-4" /> Hooks
							</CollapsibleTrigger>
							<CollapsibleContent class="pl-6">
								<AgentHooksEditor
									value={config.hooks}
									onChange={(next) => updateConfig('hooks', next)}
								/>
							</CollapsibleContent>
						</Collapsible>

						<Collapsible>
							<CollapsibleTrigger
								class="flex items-center gap-2 w-full text-left font-semibold text-sm py-2"
							>
								<ChevronRight class="size-4" /> Plugins ({(config.plugins ?? []).length})
							</CollapsibleTrigger>
							<CollapsibleContent class="pl-6">
								<Input
									value={(config.plugins ?? []).join(', ')}
									placeholder="comma-separated plugin IDs"
									oninput={(e) => {
										const ids = (e.target as HTMLInputElement).value
											.split(',')
											.map((s) => s.trim())
											.filter(Boolean);
										updateConfig('plugins', ids);
									}}
								/>
							</CollapsibleContent>
						</Collapsible>
					</TabsContent>

					<TabsContent value="sandbox" class="space-y-4">
						<p class="text-sm text-muted-foreground">
							Sandbox policy (JSON). Options: mode (per-run/per-node/provided/shared-runtime),
							template, keepAfterRun, ttlSeconds, workspaceRef.
						</p>
						<Textarea
							class="font-mono text-xs"
							rows={10}
							value={JSON.stringify(config.sandboxPolicy ?? {}, null, 2)}
							oninput={(e) => {
								try {
									const parsed = JSON.parse((e.target as HTMLTextAreaElement).value);
									updateConfig('sandboxPolicy', parsed);
								} catch {
									/* ignore */
								}
							}}
						/>
					</TabsContent>

					<TabsContent value="advanced" class="space-y-4">
						<div class="grid grid-cols-2 gap-4">
							<div>
								<Label>Max turns</Label>
								<Input
									type="number"
									value={config.maxTurns ?? 120}
									oninput={(e) =>
										updateConfig(
											'maxTurns',
											Number((e.target as HTMLInputElement).value) || undefined
										)}
								/>
							</div>
							<div>
								<Label>Timeout (minutes)</Label>
								<Input
									type="number"
									value={config.timeoutMinutes ?? 120}
									oninput={(e) =>
										updateConfig(
											'timeoutMinutes',
											Number((e.target as HTMLInputElement).value) || undefined
										)}
								/>
							</div>
							<div>
								<Label>Working directory (cwd)</Label>
								<Input
									type="text"
									placeholder="/mnt/session/repo"
									value={config.cwd ?? ''}
									oninput={(e) =>
										updateConfig(
											'cwd',
											(e.target as HTMLInputElement).value || undefined
										)}
								/>
							</div>
							<div>
								<Label>Tool choice</Label>
								<select
									class="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
									value={config.toolChoice ?? 'auto'}
									onchange={(e) =>
										updateConfig(
											'toolChoice',
											(e.target as HTMLSelectElement).value as
												| 'auto'
												| 'required'
												| 'none'
										)}
								>
									<option value="auto">auto (default)</option>
									<option value="required">required — force a tool call</option>
									<option value="none">none — disable tool calls</option>
								</select>
							</div>
							<div>
								<Label>Memory backend</Label>
								<select
									class="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
									value={config.memory?.backend ?? 'dapr_state'}
									onchange={(e) =>
										updateConfig('memory', {
											...(config?.memory ?? {}),
											backend: (e.target as HTMLSelectElement).value as
												| 'dapr_state'
												| 'conversation_list'
												| 'none'
										})}
								>
									<option value="dapr_state">dapr_state (durable)</option>
									<option value="conversation_list">conversation_list</option>
									<option value="none">none (stateless)</option>
								</select>
							</div>
							<div class="col-span-2">
								<Label>Runtime</Label>
								<select
									class="w-full mt-1 rounded-md border bg-background px-3 py-2 text-sm"
									value={agent.runtime}
									onchange={(e) => {
										if (!agent) return;
										agent = {
											...agent,
											runtime: (e.target as HTMLSelectElement).value as typeof agent.runtime
										};
										markDirty();
									}}
								>
									<option value="dapr-agent-py">dapr-agent-py</option>
									<option value="dapr-agent-py-testing">dapr-agent-py-testing</option>
								</select>
							</div>
						</div>

						<div class="space-y-3 border-t pt-4">
							<h3 class="font-semibold text-sm">Runtime override policy</h3>
							<p class="text-xs text-muted-foreground">
								Control which fields workflows can override per-node.
							</p>
							{#each Object.keys(config.runtimeOverridePolicy) as key}
								<div class="flex items-center justify-between">
									<Label class="text-sm">{key}</Label>
									<Switch
										checked={config.runtimeOverridePolicy[
											key as keyof typeof config.runtimeOverridePolicy
										]}
										onCheckedChange={(v) =>
											updateConfig('runtimeOverridePolicy', {
												...config!.runtimeOverridePolicy,
												[key]: v
											})}
									/>
								</div>
							{/each}
						</div>

						<div class="space-y-3 border-t pt-4">
							<h3 class="font-semibold text-sm">Hot-reload subscription</h3>
							<p class="text-xs text-muted-foreground">
								Optional Dapr Configuration Store subscription for persona hot-reload. Limited to
								role/goal/instructions/max_iterations.
							</p>
							<div class="grid grid-cols-2 gap-3">
								<div>
									<Label>Store name</Label>
									<Input
										value={config.configuration?.storeName ?? ''}
										oninput={(e) =>
											updateConfig('configuration', {
												...config!.configuration,
												storeName: (e.target as HTMLInputElement).value
											})}
									/>
								</div>
								<div>
									<Label>Config name</Label>
									<Input
										value={config.configuration?.configName ?? ''}
										oninput={(e) =>
											updateConfig('configuration', {
												...config!.configuration,
												configName: (e.target as HTMLInputElement).value
											})}
									/>
								</div>
							</div>
						</div>
					</TabsContent>
				</Tabs>
			</div>

			<aside class="border-l overflow-y-auto p-4 space-y-4 bg-muted/30">
				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm flex items-center gap-2">
							<Workflow class="size-4" /> Used by ({usages.length})
						</CardTitle>
					</CardHeader>
					<CardContent>
						{#if usages.length === 0}
							<p class="text-xs text-muted-foreground">
								Not referenced by any workflow yet. Add it in the workflow node's side panel.
							</p>
						{:else}
							<ul class="space-y-1">
								{#each usages as u}
									<li>
										<a
											href="/workflows/{u.workflowId}"
											class="text-sm hover:underline flex items-center gap-1"
										>
											{u.workflowName}
											<ExternalLink class="size-3" />
											<span class="text-xs text-muted-foreground">
												({u.nodeIds.length} node{u.nodeIds.length === 1 ? '' : 's'})
											</span>
										</a>
									</li>
								{/each}
							</ul>
						{/if}
					</CardContent>
				</Card>

				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm flex items-center gap-2">
							<Play class="size-4" /> Test
						</CardTitle>
					</CardHeader>
					<CardContent>
						<AgentTestPane {agentId} />
					</CardContent>
				</Card>
			</aside>
		</div>
	{/if}
</div>

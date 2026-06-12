<script lang="ts" module>
	function formatValue(v: unknown): string {
		if (v === undefined) return '';
		if (typeof v === 'string') return v.length > 600 ? v.slice(0, 600) + '…' : v;
		try {
			return JSON.stringify(v, null, 2);
		} catch {
			return String(v);
		}
	}
</script>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Badge } from '$lib/components/ui/badge';
	import * as Sheet from '$lib/components/ui/sheet';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		AlertCircle,
		ChevronDown,
		Loader2,
		Play,
		RotateCcw,
		Save,
		Sparkles
	} from '@lucide/svelte';
	import AgentModelSelector from '$lib/components/agents/agent-model-selector.svelte';
	import AgentSkillsPicker from '$lib/components/agents/agent-skills-picker.svelte';
	import AgentToolsIntegrations from '$lib/components/agents/tools-integrations/AgentToolsIntegrations.svelte';
	import AgentHooksEditor from '$lib/components/agents/agent-hooks-editor.svelte';
	import CallableAgentsPicker from '$lib/components/agents/callable-agents-picker.svelte';
	import BundleRefsPicker from '$lib/components/capabilities/bundle-refs-picker.svelte';
	import PromptContentEditor from '$lib/components/agents/prompt-content-editor.svelte';
	import RepositoriesEditor from '$lib/components/sessions/repositories-editor.svelte';
	import type { AgentDetail, AgentConfig } from '$lib/types/agents';
	import type { SessionRepositoryInput } from '$lib/types/sessions';
	import {
		diffAgentConfig,
		summarizeDiff,
		groupDiff,
		isAgentConfigEquivalent
	} from '$lib/utils/agent-config-diff';

	interface Props {
		baseAgent: AgentDetail;
		initialConfig?: AgentConfig | null;
		mode: 'create' | 'fork';
		sessionId?: string;
		fromSequence?: number;
		workspaceSlug: string;
		/** Workspace project id — used for the callable-agents picker scope and
		 *  the new-agent project assignment. AgentDetail doesn't carry projectId
		 *  today, so callers pass it from page context. */
		projectId: string | null;
		open: boolean;
		onOpenChange?: (open: boolean) => void;
		onSubmit?: (result: { sessionId: string }) => void;
	}

	let {
		baseAgent,
		initialConfig = null,
		mode,
		sessionId,
		fromSequence,
		workspaceSlug,
		projectId,
		open = $bindable(false),
		onOpenChange,
		onSubmit
	}: Props = $props();

	const baselineConfig = $derived(initialConfig ?? baseAgent.config);

	let draftConfig = $state<AgentConfig>(structuredClone($state.snapshot(baselineConfig) ?? baselineConfig));

	let title = $state('');
	let initialMessage = $state('');
	let repositories = $state<SessionRepositoryInput[]>([]);
	// Editor instance — flush a half-entered repo before submit (see commitPending).
	let repoEditor = $state<{ commitPending?: () => boolean } | undefined>(undefined);
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let savingTweaks = $state(false);
	let saveError = $state<string | null>(null);
	let showDiffSheet = $state(false);
	let showSaveAsNewDialog = $state(false);
	let showReplaceConfirmDialog = $state(false);
	let newAgentName = $state('');
	let newAgentSlug = $state('');

	$effect(() => {
		void open;
		void baseAgent.id;
		void initialConfig;
		if (open) {
			draftConfig = structuredClone($state.snapshot(baselineConfig) ?? baselineConfig);
			title = mode === 'fork' ? `Fork of ${baseAgent.name}` : '';
			initialMessage = '';
			repositories = [];
			submitError = null;
			showDiffSheet = false;
			showSaveAsNewDialog = false;
			showReplaceConfirmDialog = false;
		}
	});

	const diff = $derived(diffAgentConfig(baselineConfig, draftConfig));
	const hasTweaks = $derived(diff.length > 0);
	const diffSummary = $derived(summarizeDiff(diff));

	function patchConfig<K extends keyof AgentConfig>(key: K, value: AgentConfig[K]) {
		draftConfig = { ...draftConfig, [key]: value };
	}

	function openChange(next: boolean) {
		open = next;
		onOpenChange?.(next);
	}

	async function submit() {
		submitting = true;
		submitError = null;
		// Flush a pending repo (URL entered but inner "Add" never clicked) so it
		// still ships in `resources` instead of being silently lost.
		repoEditor?.commitPending?.();
		try {
			const includeConfig = !isAgentConfigEquivalent(baselineConfig, draftConfig);
			const body: Record<string, unknown> = {};
			if (includeConfig) body.agentConfig = $state.snapshot(draftConfig);

			if (mode === 'create') {
				body.agentId = baseAgent.id;
				if (baseAgent.currentVersion != null) body.agentVersion = baseAgent.currentVersion;
				if (title.trim()) body.title = title.trim();
				if (initialMessage.trim()) body.initialMessage = initialMessage.trim();
				if (repositories.length > 0) body.resources = $state.snapshot(repositories);
				const res = await fetch('/api/v1/sessions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				});
				if (!res.ok) {
					const text = await res.text().catch(() => '');
					throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
				}
				const json = (await res.json()) as { session: { id: string } };
				openChange(false);
				onSubmit?.({ sessionId: json.session.id });
				await goto(`/workspaces/${workspaceSlug}/sessions/${json.session.id}`);
			} else {
				if (!sessionId) throw new Error('sessionId is required for fork mode');
				if (!fromSequence) throw new Error('fromSequence is required for fork mode');
				body.fromSequence = fromSequence;
				if (title.trim()) body.title = title.trim();
				const res = await fetch(`/api/v1/sessions/${sessionId}/fork`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body)
				});
				if (!res.ok) {
					const text = await res.text().catch(() => '');
					throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
				}
				const json = (await res.json()) as { sessionId: string };
				openChange(false);
				onSubmit?.({ sessionId: json.sessionId });
				await goto(`/workspaces/${workspaceSlug}/sessions/${json.sessionId}`);
			}
		} catch (err) {
			submitError = err instanceof Error ? err.message : String(err);
		} finally {
			submitting = false;
		}
	}

	function discardTweaks() {
		draftConfig = structuredClone($state.snapshot(baselineConfig) ?? baselineConfig);
	}

	async function replaceAgent() {
		savingTweaks = true;
		saveError = null;
		try {
			const res = await fetch(`/api/agents/${baseAgent.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					config: $state.snapshot(draftConfig),
					changelog: 'Promoted from SessionConfigDrawer experiment'
				})
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
			}
			showReplaceConfirmDialog = false;
			openChange(false);
		} catch (err) {
			saveError = err instanceof Error ? err.message : String(err);
		} finally {
			savingTweaks = false;
		}
	}

	async function saveAsNewAgent() {
		if (!newAgentName.trim()) {
			saveError = 'Name is required';
			return;
		}
		savingTweaks = true;
		saveError = null;
		try {
			const res = await fetch('/api/agents', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					name: newAgentName.trim(),
					slug: newAgentSlug.trim() || undefined,
					config: $state.snapshot(draftConfig),
					projectId
				})
			});
			if (!res.ok) {
				const text = await res.text().catch(() => '');
				throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
			}
			const json = (await res.json()) as { agent: { id: string } };
			showSaveAsNewDialog = false;
			openChange(false);
			await goto(`/workspaces/${workspaceSlug}/agents/${json.agent.id}`);
		} catch (err) {
			saveError = err instanceof Error ? err.message : String(err);
		} finally {
			savingTweaks = false;
		}
	}

	function autoSlugFromName(name: string): string {
		return name
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 48);
	}

	$effect(() => {
		if (showSaveAsNewDialog && newAgentName && !newAgentSlug) {
			newAgentSlug = autoSlugFromName(newAgentName);
		}
	});
</script>

{#snippet sectionHeader(label: string)}
	<h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</h3>
{/snippet}

<Sheet.Root bind:open onOpenChange={openChange}>
	<Sheet.Content class="w-full sm:max-w-[640px] flex flex-col gap-0 p-0">
		<Sheet.Header class="border-b px-5 py-3.5">
			<div class="flex items-start justify-between gap-3">
				<div class="min-w-0 space-y-1">
					<Sheet.Title class="flex items-center gap-2 text-base font-semibold">
						<Play class="size-4 text-primary" />
						{mode === 'create' ? 'Run agent' : 'Fork session with edits'}
					</Sheet.Title>
					<Sheet.Description class="text-xs text-muted-foreground">
						{#if mode === 'create'}
							Starting from <span class="font-medium text-foreground">{baseAgent.name}</span> ·
							tweak any field below to experiment without changing the agent.
						{:else}
							Replays events 1–{fromSequence} into a new session. Tweaks become a hidden
							experiment agent.
						{/if}
					</Sheet.Description>
				</div>
				{#if hasTweaks}
					<button
						type="button"
						class="shrink-0 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
						onclick={() => (showDiffSheet = true)}
					>
						{diff.length} {diff.length === 1 ? 'change' : 'changes'} ›
					</button>
				{/if}
			</div>
		</Sheet.Header>

		<div class="flex-1 overflow-y-auto px-5 py-4 space-y-5">
			{#if mode === 'create'}
				<section>
					{@render sectionHeader('Session')}
					<div class="space-y-2">
						<div class="space-y-1.5">
							<Label for="scd-title" class="text-xs">Title (optional)</Label>
							<Input
								id="scd-title"
								bind:value={title}
								placeholder="e.g. Test new prompt"
								class="h-8 text-sm"
							/>
						</div>
						<div class="space-y-1.5">
							<Label for="scd-initial" class="text-xs">Kickoff message (optional)</Label>
							<Textarea
								id="scd-initial"
								bind:value={initialMessage}
								placeholder="Send a message to start the agent…"
								rows={3}
								class="text-sm"
							/>
						</div>
						<div class="space-y-1.5">
							<Label class="text-xs">Repositories (optional)</Label>
							<RepositoriesEditor
								bind:this={repoEditor}
								{workspaceSlug}
								value={repositories}
								onChange={(r) => (repositories = r)}
							/>
						</div>
					</div>
				</section>
			{/if}

			<section>
				{@render sectionHeader('Model')}
				<div class="space-y-2">
					<AgentModelSelector
						value={draftConfig.modelSpec ?? null}
						onSelect={(modelSpec) => patchConfig('modelSpec', modelSpec)}
					/>
					<div class="grid grid-cols-3 gap-2">
						<div class="space-y-1">
							<Label class="text-xs" for="scd-temperature">Temperature</Label>
							<Input
								id="scd-temperature"
								type="number"
								min="0"
								max="2"
								step="0.1"
								value={draftConfig.temperature ?? ''}
								class="h-8 text-sm"
								oninput={(e) => {
									const raw = (e.target as HTMLInputElement).value;
									if (raw === '') {
										patchConfig('temperature', undefined);
										return;
									}
									const v = Number(raw);
									patchConfig('temperature', Number.isFinite(v) ? v : undefined);
								}}
							/>
						</div>
						<div class="space-y-1">
							<Label class="text-xs" for="scd-maxturns">Max turns</Label>
							<Input
								id="scd-maxturns"
								type="number"
								min="1"
								value={draftConfig.maxTurns ?? ''}
								class="h-8 text-sm"
								oninput={(e) => {
									const raw = (e.target as HTMLInputElement).value;
									if (raw === '') {
										patchConfig('maxTurns', undefined);
										return;
									}
									const v = Number(raw);
									patchConfig('maxTurns', Number.isFinite(v) ? v : undefined);
								}}
							/>
						</div>
						<div class="space-y-1">
							<Label class="text-xs" for="scd-cachettl">Cache TTL</Label>
							<select
								id="scd-cachettl"
								class="h-8 w-full rounded-md border border-input bg-transparent px-2 text-sm"
								value={draftConfig.cacheTtl ?? ''}
								onchange={(e) => {
									const v = (e.target as HTMLSelectElement).value;
									patchConfig('cacheTtl', v === '5m' || v === '1h' ? v : undefined);
								}}
							>
								<option value="">default</option>
								<option value="5m">5m</option>
								<option value="1h">1h</option>
							</select>
						</div>
					</div>
				</div>
			</section>

			<section>
				{@render sectionHeader('System prompt')}
				<PromptContentEditor
					value={draftConfig.systemPrompt ?? ''}
					onChange={(v) => patchConfig('systemPrompt', v)}
					placeholder="The agent's persona — plain text or markdown"
					minHeight="180px"
				/>
			</section>

			<section>
				{@render sectionHeader('Skills')}
				<AgentSkillsPicker
					value={draftConfig.skills ?? []}
					onChange={(v) => patchConfig('skills', v)}
				/>
			</section>

			<section>
				{@render sectionHeader('Tools & Integrations')}
				<AgentToolsIntegrations
					value={draftConfig.mcpServers ?? []}
					connectionMode={draftConfig.mcpConnectionMode ?? 'auto'}
					vaultIds={baseAgent.defaultVaultIds ?? []}
					onModeChange={(m) => patchConfig('mcpConnectionMode', m)}
					onChange={(v) => patchConfig('mcpServers', v)}
				/>
			</section>

			<section>
				{@render sectionHeader('Hooks')}
				<AgentHooksEditor
					value={draftConfig.hooks}
					onChange={(v) => patchConfig('hooks', v)}
				/>
			</section>

			<section>
				{@render sectionHeader('Callable agents')}
				<CallableAgentsPicker
					value={draftConfig.callableAgents ?? []}
					selfSlug={baseAgent.slug}
					{projectId}
					onChange={(v) => patchConfig('callableAgents', v)}
				/>
			</section>

			<section>
				{@render sectionHeader('Capability bundles')}
				<BundleRefsPicker
					value={draftConfig.bundleRefs ?? []}
					{projectId}
					onChange={(v) => patchConfig('bundleRefs', v)}
				/>
			</section>
		</div>

		<Sheet.Footer class="border-t px-5 py-3 flex flex-row items-center justify-between gap-2">
			<div class="flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
				{#if hasTweaks}
					<Sparkles class="size-3 shrink-0" />
					<span class="truncate" title={diffSummary}>{diffSummary}</span>
				{:else}
					<span>No tweaks · using published config</span>
				{/if}
			</div>
			<div class="flex items-center gap-2 shrink-0">
				{#if hasTweaks}
					<Button variant="ghost" size="sm" class="h-8 gap-1 text-xs" onclick={discardTweaks}>
						<RotateCcw class="size-3" />
						Discard
					</Button>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="outline" size="sm" class="h-8 gap-1 text-xs">
									<Save class="size-3" />
									Save tweaks
									<ChevronDown class="size-3" />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="w-56">
							<DropdownMenu.Item onclick={() => (showReplaceConfirmDialog = true)}>
								Replace agent ({baseAgent.name})
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={() => (showSaveAsNewDialog = true)}>
								Save as new agent…
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				{/if}
				<Button size="sm" class="h-8 gap-1 text-xs" onclick={submit} disabled={submitting}>
					{#if submitting}
						<Loader2 class="size-3 animate-spin" />
					{:else}
						<Play class="size-3" />
					{/if}
					{mode === 'create' ? 'Start session' : 'Fork with edits'}
				</Button>
			</div>
		</Sheet.Footer>

		{#if submitError}
			<div class="border-t border-rose-500/30 bg-rose-500/5 px-5 py-2 text-[11px] text-rose-300 flex items-center gap-2">
				<AlertCircle class="size-3" />
				{submitError}
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>

<!-- Diff sheet — opens on top of the drawer -->
<Sheet.Root bind:open={showDiffSheet}>
	<Sheet.Content class="w-full sm:max-w-[480px] flex flex-col gap-0 p-0">
		<Sheet.Header class="border-b px-5 py-3.5">
			<Sheet.Title class="text-base">Tweaks vs published</Sheet.Title>
			<Sheet.Description class="text-xs">{diffSummary || 'No changes'}</Sheet.Description>
		</Sheet.Header>
		<div class="flex-1 overflow-y-auto px-5 py-4 space-y-3">
			{#each [...groupDiff(diff).entries()] as [group, entries] (group)}
				<section class="space-y-1.5">
					<h4 class="text-[10px] uppercase tracking-wider text-muted-foreground">{group}</h4>
					<ul class="space-y-1.5">
						{#each entries as entry (entry.path)}
							<li class="rounded border border-border/60 bg-card/40 px-2.5 py-2 text-[11px]">
								<div class="flex items-center gap-1.5">
									<Badge
										variant="outline"
										class={'h-4 px-1.5 text-[9px] ' +
											(entry.kind === 'added'
												? 'border-emerald-500/40 text-emerald-500'
												: entry.kind === 'removed'
													? 'border-rose-500/40 text-rose-500'
													: 'border-amber-500/40 text-amber-500')}
									>
										{entry.kind}
									</Badge>
									<span class="font-mono">{entry.label}</span>
								</div>
								{#if entry.kind !== 'added' && entry.before !== undefined}
									<pre class="mt-1 max-h-[8em] overflow-auto whitespace-pre-wrap break-all rounded bg-rose-500/5 p-1.5 text-[10px] text-rose-300">{formatValue(entry.before)}</pre>
								{/if}
								{#if entry.kind !== 'removed' && entry.after !== undefined}
									<pre class="mt-1 max-h-[8em] overflow-auto whitespace-pre-wrap break-all rounded bg-emerald-500/5 p-1.5 text-[10px] text-emerald-300">{formatValue(entry.after)}</pre>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	</Sheet.Content>
</Sheet.Root>

<!-- Save as new agent dialog -->
<Dialog.Root bind:open={showSaveAsNewDialog}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Save as new agent</Dialog.Title>
			<Dialog.Description>
				Creates a fresh agent with the tweaked config. The original agent stays unchanged.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-3 py-2">
			<div class="space-y-1.5">
				<Label for="scd-newagent-name" class="text-xs">Name</Label>
				<Input
					id="scd-newagent-name"
					bind:value={newAgentName}
					placeholder="My experimental agent"
				/>
			</div>
			<div class="space-y-1.5">
				<Label for="scd-newagent-slug" class="text-xs">Slug (auto-generated)</Label>
				<Input
					id="scd-newagent-slug"
					bind:value={newAgentSlug}
					placeholder="my-experimental-agent"
				/>
			</div>
			{#if saveError}
				<div class="rounded border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-300">
					{saveError}
				</div>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" size="sm" onclick={() => (showSaveAsNewDialog = false)}>Cancel</Button>
			<Button size="sm" onclick={saveAsNewAgent} disabled={savingTweaks || !newAgentName.trim()}>
				{#if savingTweaks}<Loader2 class="size-3 animate-spin" />{/if}
				Create agent
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Replace agent confirm dialog -->
<Dialog.Root bind:open={showReplaceConfirmDialog}>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Replace agent {baseAgent.name}?</Dialog.Title>
			<Dialog.Description>
				This bumps the agent to a new version. Existing sessions keep their pinned version;
				new sessions and workflows get the tweaked config.
			</Dialog.Description>
		</Dialog.Header>
		<div class="max-h-[40vh] overflow-y-auto space-y-2 py-2 text-[11px]">
			<div class="text-muted-foreground">{diff.length} change(s):</div>
			{#each diff as entry (entry.path)}
				<div class="rounded border border-border/60 px-2.5 py-1.5">
					<span class="font-mono">{entry.label}</span>
					<Badge
						variant="outline"
						class={'ml-1.5 h-4 px-1.5 text-[9px] ' +
							(entry.kind === 'added'
								? 'border-emerald-500/40 text-emerald-500'
								: entry.kind === 'removed'
									? 'border-rose-500/40 text-rose-500'
									: 'border-amber-500/40 text-amber-500')}
					>
						{entry.kind}
					</Badge>
				</div>
			{/each}
		</div>
		{#if saveError}
			<div class="rounded border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-[11px] text-rose-300">
				{saveError}
			</div>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" size="sm" onclick={() => (showReplaceConfirmDialog = false)}>Cancel</Button>
			<Button size="sm" onclick={replaceAgent} disabled={savingTweaks}>
				{#if savingTweaks}<Loader2 class="size-3 animate-spin" />{/if}
				Replace {baseAgent.name}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

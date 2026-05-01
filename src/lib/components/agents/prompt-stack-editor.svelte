<script lang="ts">
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import * as Popover from '$lib/components/ui/popover';
	import {
		AlertCircle,
		ExternalLink,
		GripVertical,
		Plus,
		Search,
		Sparkles,
		X
	} from '@lucide/svelte';
	import type {
		AgentConfig,
		AgentDetail,
		PromptPresetRef
	} from '$lib/types/agents';
	import type {
		PromptPresetSummary,
		PromptTemplateMessage
	} from '$lib/types/prompt-presets';
	import {
		SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
		buildOpenShellSystemPrompt,
		renderInstructionSystemText
	} from '$lib/agents/instruction-bundle-renderer';

	interface Props {
		agent: AgentDetail;
		config: AgentConfig;
		onPatch: (patch: Partial<AgentConfig>) => void;
		workspaceSlug: string;
	}

	let { agent, config, onPatch, workspaceSlug }: Props = $props();

	// Static prefix needs ≥1024 tokens (~4000 chars) for Anthropic ephemeral cache
	// to be useful — must match SYSTEM_PROMPT_CACHE_THRESHOLD_CHARS in
	// services/dapr-agent-py/src/anthropic_adapter.py.
	const CACHE_THRESHOLD_CHARS = 4000;

	type DragState = { kind: 'static' | 'dynamic'; index: number } | null;

	let presets = $state<PromptPresetSummary[]>([]);
	let loadingPresets = $state(false);
	let presetError = $state<string | null>(null);
	let dragState = $state<DragState>(null);
	let pickerKind = $state<'static' | 'dynamic' | null>(null);
	let pickerSearch = $state('');

	const staticBindings = $derived<PromptPresetRef[]>(
		Array.isArray(config.staticPromptPresetRefs) ? config.staticPromptPresetRefs : []
	);
	const dynamicBindings = $derived<PromptPresetRef[]>(
		Array.isArray(config.dynamicPromptPresetRefs) ? config.dynamicPromptPresetRefs : []
	);
	const presetById = $derived(
		new Map(presets.map((p) => [p.id, p] as const))
	);

	// Resolve binding → system content (mirrors the BFF's compilePromptStack helper).
	// This is preview-only: the deployed BFF re-resolves at session-spawn for the
	// canonical bundle and reaches the runtime via compiledStaticPresetSections.
	function resolveBinding(ref: PromptPresetRef): string | null {
		const preset = presetById.get(ref.id);
		if (!preset) return null;
		const messages = (preset.latestVersion?.messages ?? []) as PromptTemplateMessage[];
		const sys = messages.find((m) => m.role === 'system');
		const content = sys?.content?.trim();
		return content || null;
	}

	const compiledStatic = $derived(
		staticBindings.map(resolveBinding).filter((c): c is string => Boolean(c))
	);
	const compiledDynamic = $derived(
		dynamicBindings.map(resolveBinding).filter((c): c is string => Boolean(c))
	);

	const platformSection = $derived(
		buildOpenShellSystemPrompt(config.cwd ?? '/sandbox', 'preview-sandbox')
	);

	// Build the full preview using the same renderer the runtime + session-spawn use,
	// so the Stack editor's preview is byte-equivalent to what dapr-agent-py renders
	// (modulo currentDate/hookContext which are runtime-only).
	const previewToday = new Date().toISOString().slice(0, 10);
	const renderedSystem = $derived(
		renderInstructionSystemText({
			persona: {
				role: config.role,
				goal: config.goal,
				instructions: config.instructions,
				styleGuidelines: config.styleGuidelines,
				systemPrompt: config.systemPrompt,
				customSystemPrompt: config.customSystemPrompt,
				appendSystemPrompt: config.appendSystemPrompt
			},
			runtime: {
				cwd: config.cwd ?? '/sandbox',
				sandboxName: 'preview-sandbox',
				skills: skillNames(config.skills),
				platformSystemSections: [platformSection],
				currentDate: previewToday,
				compiledStaticPresetSections: compiledStatic,
				compiledDynamicPresetSections: compiledDynamic
			}
		})
	);

	const renderedParts = $derived.by(() => {
		const idx = renderedSystem.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
		if (idx === -1) {
			return { staticText: renderedSystem.trim(), dynamicText: '' };
		}
		return {
			staticText: renderedSystem.slice(0, idx).trim(),
			dynamicText: renderedSystem.slice(idx + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length).trim()
		};
	});

	const prefixChars = $derived(renderedParts.staticText.length);
	const tailChars = $derived(renderedParts.dynamicText.length);
	const cacheEligible = $derived(prefixChars >= CACHE_THRESHOLD_CHARS);

	const customCharCount = $derived((config.customSystemPrompt ?? '').length);
	const appendCharCount = $derived((config.appendSystemPrompt ?? '').length);
	const legacyFields = $derived.by(() => {
		const present: string[] = [];
		if (cleanString(config.role)) present.push('role');
		if (cleanString(config.goal)) present.push('goal');
		if (cleanString(config.systemPrompt)) present.push('systemPrompt');
		if (Array.isArray(config.instructions) && config.instructions.length > 0)
			present.push('instructions');
		if (Array.isArray(config.styleGuidelines) && config.styleGuidelines.length > 0)
			present.push('styleGuidelines');
		return present;
	});

	function cleanString(value: unknown): string | null {
		return typeof value === 'string' && value.trim() ? value.trim() : null;
	}

	function migrateLegacyToCustom() {
		// Render the persona-static section the same way the bundle does so the
		// merged content keeps section headers (## Role / ## Goal / etc.). The
		// renderer skips empty inputs, so this is safe regardless of which
		// legacy fields happen to be populated.
		const merged = renderInstructionSystemText({
			persona: {
				role: config.role,
				goal: config.goal,
				systemPrompt: config.systemPrompt,
				instructions: config.instructions,
				styleGuidelines: config.styleGuidelines
			},
			runtime: {}
		}).trim();
		// Append to any existing customSystemPrompt rather than overwriting, so
		// the migration is non-destructive when both are populated.
		const existing = (config.customSystemPrompt ?? '').trim();
		const combined = existing
			? `${existing}\n\n${merged}`
			: merged;
		onPatch({
			customSystemPrompt: combined,
			role: '',
			goal: '',
			systemPrompt: '',
			instructions: [],
			styleGuidelines: []
		});
	}

	// Available presets for picker (excludes those already bound on the same side).
	const availableForStatic = $derived(
		presets.filter((p) => !staticBindings.some((b) => b.id === p.id))
	);
	const availableForDynamic = $derived(
		presets.filter((p) => !dynamicBindings.some((b) => b.id === p.id))
	);
	const pickerCandidates = $derived.by(() => {
		const pool = pickerKind === 'static' ? availableForStatic : availableForDynamic;
		const q = pickerSearch.trim().toLowerCase();
		if (!q) return pool;
		return pool.filter(
			(p) =>
				p.title.toLowerCase().includes(q) ||
				(p.description ?? '').toLowerCase().includes(q)
		);
	});

	onMount(loadPresets);

	async function loadPresets() {
		loadingPresets = true;
		presetError = null;
		try {
			const res = await fetch('/api/prompt-presets');
			if (!res.ok) {
				presetError = `Failed to load prompt presets (${res.status})`;
				return;
			}
			const data = (await res.json()) as { presets: PromptPresetSummary[] };
			presets = data.presets ?? [];
		} catch (err) {
			presetError = err instanceof Error ? err.message : String(err);
		} finally {
			loadingPresets = false;
		}
	}

	function addBinding(kind: 'static' | 'dynamic', presetId: string) {
		const preset = presetById.get(presetId);
		if (!preset) return;
		const version = preset.latestVersion?.version ?? preset.version;
		const ref: PromptPresetRef = { id: preset.id, version };
		if (kind === 'static') {
			onPatch({ staticPromptPresetRefs: [...staticBindings, ref] });
		} else {
			onPatch({ dynamicPromptPresetRefs: [...dynamicBindings, ref] });
		}
		pickerKind = null;
		pickerSearch = '';
	}

	function removeBinding(kind: 'static' | 'dynamic', index: number) {
		if (kind === 'static') {
			const next = staticBindings.filter((_, i) => i !== index);
			onPatch({ staticPromptPresetRefs: next });
		} else {
			const next = dynamicBindings.filter((_, i) => i !== index);
			onPatch({ dynamicPromptPresetRefs: next });
		}
	}

	function reorderBinding(
		kind: 'static' | 'dynamic',
		fromIdx: number,
		toIdx: number
	) {
		if (fromIdx === toIdx) return;
		const source = kind === 'static' ? [...staticBindings] : [...dynamicBindings];
		const [moved] = source.splice(fromIdx, 1);
		source.splice(toIdx, 0, moved);
		if (kind === 'static') onPatch({ staticPromptPresetRefs: source });
		else onPatch({ dynamicPromptPresetRefs: source });
	}

	function bumpVersion(kind: 'static' | 'dynamic', index: number) {
		const refs = kind === 'static' ? staticBindings : dynamicBindings;
		const ref = refs[index];
		const preset = presetById.get(ref.id);
		const latest = preset?.latestVersion?.version ?? preset?.version;
		if (!latest || latest === ref.version) return;
		const next = refs.map((r, i) =>
			i === index ? { id: r.id, version: latest } : r
		);
		if (kind === 'static') onPatch({ staticPromptPresetRefs: next });
		else onPatch({ dynamicPromptPresetRefs: next });
	}

	function handleDragStart(kind: 'static' | 'dynamic', index: number) {
		dragState = { kind, index };
	}

	function handleDragOver(event: DragEvent) {
		event.preventDefault();
	}

	function handleDrop(
		event: DragEvent,
		kind: 'static' | 'dynamic',
		toIdx: number
	) {
		event.preventDefault();
		if (!dragState || dragState.kind !== kind) {
			dragState = null;
			return;
		}
		reorderBinding(kind, dragState.index, toIdx);
		dragState = null;
	}

	function handleDragEnd() {
		dragState = null;
	}

	function skillNames(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return value
			.map((item) => {
				if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
				const r = item as Record<string, unknown>;
				return (
					textValue(r.name) ??
					textValue(r.skillName) ??
					textValue(r.skill_name) ??
					textValue(r.slug)
				);
			})
			.filter((n): n is string => Boolean(n));
	}

	function textValue(value: unknown): string | null {
		return typeof value === 'string' && value.trim() ? value.trim() : null;
	}

	function bindingPreview(ref: PromptPresetRef): {
		preset: PromptPresetSummary | null;
		content: string;
		latestVersion: number | null;
		isStale: boolean;
	} {
		const preset = presetById.get(ref.id) ?? null;
		const content = resolveBinding(ref) ?? '';
		const latestVersion = preset?.latestVersion?.version ?? preset?.version ?? null;
		const isStale = latestVersion !== null && latestVersion > ref.version;
		return { preset, content, latestVersion, isStale };
	}

	function presetCharCount(preset: PromptPresetSummary): number {
		const sys = (preset.latestVersion?.messages ?? []).find(
			(m) => m.role === 'system'
		);
		return (sys?.content ?? '').trim().length;
	}
</script>

<div class="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
	<!-- Left: Stack editor -->
	<div class="min-w-0 space-y-3">
		<div class="flex items-center justify-between">
			<div>
				<h3 class="text-sm font-semibold">Prompt Stack</h3>
				<p class="text-xs text-muted-foreground">
					Static prefix is cacheable; dynamic tail recomputes per turn.
				</p>
			</div>
			<a
				href="/workspaces/{workspaceSlug}/prompts"
				class="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
			>
				Manage presets <ExternalLink class="size-3" />
			</a>
		</div>

		{#if presetError}
			<Alert>
				<AlertDescription>{presetError}</AlertDescription>
			</Alert>
		{/if}

		<!-- STATIC PREFIX -->
		<div class="space-y-1.5 rounded-lg border bg-muted/10 p-3">
			<div class="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
				<span>Static prefix</span>
				<span class="text-muted-foreground/60">cacheable</span>
			</div>

			<!-- Platform (system-provided, non-editable) -->
			<div class="flex items-center gap-2 rounded-md border border-dashed border-border/60 bg-background/50 px-3 py-1.5 text-xs">
				<Badge variant="outline" class="text-[10px]">system</Badge>
				<span class="font-medium">Platform (OpenShell sandbox intro)</span>
				<span class="ml-auto tabular-nums text-muted-foreground">
					{platformSection.length}ch
				</span>
			</div>

			<!-- Static bindings -->
			{#each staticBindings as ref, i (ref.id + '@' + ref.version + ':' + i)}
				{@const info = bindingPreview(ref)}
				<div
					class="group flex items-center gap-2 rounded-md border bg-cyan-50/30 px-2 py-1.5 text-xs transition-colors hover:border-cyan-300 dark:bg-cyan-950/20"
					draggable="true"
					ondragstart={() => handleDragStart('static', i)}
					ondragover={handleDragOver}
					ondrop={(e) => handleDrop(e, 'static', i)}
					ondragend={handleDragEnd}
					role="listitem"
				>
					<GripVertical class="size-3.5 cursor-grab text-muted-foreground active:cursor-grabbing" />
					<Badge variant="outline" class="text-[10px]">bound</Badge>
					{#if info.preset}
						<span class="truncate font-medium">{info.preset.title}</span>
					{:else}
						<span class="italic text-amber-600">[preset {ref.id} not found]</span>
					{/if}
					<button
						type="button"
						class="rounded px-1 py-0.5 text-[10px] font-mono tabular-nums hover:bg-accent {info.isStale
							? 'text-amber-600'
							: 'text-muted-foreground'}"
						title={info.isStale
							? `Pinned to v${ref.version}. Latest is v${info.latestVersion}. Click to bump.`
							: `Pinned to v${ref.version}`}
						onclick={() => info.isStale && bumpVersion('static', i)}
						disabled={!info.isStale}
					>
						v{ref.version}{info.isStale ? ` → v${info.latestVersion}` : ''}
					</button>
					<span class="ml-auto tabular-nums text-muted-foreground">
						{info.content.length}ch
					</span>
					<button
						type="button"
						class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						aria-label="Remove binding"
						onclick={() => removeBinding('static', i)}
					>
						<X class="size-3" />
					</button>
				</div>
			{/each}

			<!-- Add static binding -->
			<Popover.Root
				open={pickerKind === 'static'}
				onOpenChange={(open) => {
					if (!open && pickerKind === 'static') {
						pickerKind = null;
						pickerSearch = '';
					}
				}}
			>
				<Popover.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							type="button"
							class="flex w-full items-center justify-center gap-1 rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground hover:border-cyan-400 hover:bg-cyan-50/40 dark:hover:bg-cyan-950/20"
							onclick={() => (pickerKind = 'static')}
						>
							<Plus class="size-3.5" /> Add static preset
						</button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content class="w-80 p-0" align="start">
					<div class="border-b p-2">
						<div class="flex items-center gap-2">
							<Search class="size-3.5 text-muted-foreground" />
							<Input
								class="h-7 border-0 px-1 text-xs focus-visible:ring-0"
								placeholder="Search presets..."
								bind:value={pickerSearch}
							/>
						</div>
					</div>
					<div class="max-h-72 overflow-y-auto py-1">
						{#if loadingPresets}
							<div class="px-3 py-4 text-center text-xs text-muted-foreground">Loading...</div>
						{:else if pickerCandidates.length === 0}
							<div class="px-3 py-4 text-center text-xs text-muted-foreground">
								{availableForStatic.length === 0 && presets.length > 0
									? 'All presets already bound here.'
									: presets.length === 0
									? 'No presets yet. Create one in Prompts.'
									: 'No matches.'}
							</div>
						{:else}
							{#each pickerCandidates as preset (preset.id)}
								<button
									type="button"
									class="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs hover:bg-accent"
									onclick={() => addBinding('static', preset.id)}
								>
									<div class="flex items-center justify-between">
										<span class="font-medium">{preset.title}</span>
										<span class="tabular-nums text-muted-foreground">
											v{preset.latestVersion?.version ?? preset.version} · {presetCharCount(preset)}ch
										</span>
									</div>
									{#if preset.description}
										<span class="line-clamp-1 text-muted-foreground">
											{preset.description}
										</span>
									{/if}
								</button>
							{/each}
						{/if}
					</div>
				</Popover.Content>
			</Popover.Root>

			<!-- Agent voice (the agent's primary system-prompt content) -->
			<div class="rounded-md border border-amber-300/50 bg-amber-50/40 p-2 dark:border-amber-700/50 dark:bg-amber-950/10">
				<div class="mb-1.5 flex items-center gap-2 text-xs">
					<Badge variant="outline" class="text-[10px]">agent</Badge>
					<span class="font-medium">Custom system prompt</span>
					<span class="ml-auto tabular-nums text-muted-foreground">
						{customCharCount}ch
					</span>
				</div>

				{#if legacyFields.length > 0}
					<div class="mb-2 flex items-start gap-2 rounded-md border border-amber-400/60 bg-amber-100/50 p-2 text-[11px] dark:border-amber-500/40 dark:bg-amber-900/30">
						<AlertCircle class="mt-0.5 size-3.5 shrink-0 text-amber-700 dark:text-amber-400" />
						<div class="flex-1 space-y-1">
							<div class="leading-snug">
								Legacy persona fields populated:
								<code class="rounded bg-background px-1 py-px font-mono text-[10px]">{legacyFields.join(', ')}</code>.
								They still render in the prompt but are no longer editable here. Bind reusable blocks via static/dynamic preset refs above; put per-agent voice in the custom system prompt below.
							</div>
							<button
								type="button"
								class="rounded bg-amber-200 px-2 py-0.5 text-[10px] font-medium text-amber-900 transition-colors hover:bg-amber-300 dark:bg-amber-800 dark:text-amber-100 dark:hover:bg-amber-700"
								onclick={migrateLegacyToCustom}
							>
								Merge legacy fields into custom system prompt
							</button>
						</div>
					</div>
				{/if}

				<Textarea
					rows={6}
					class="text-xs"
					value={config.customSystemPrompt ?? ''}
					placeholder={'The agent\'s voice. Plain text or markdown — no special structure required. Bind reusable blocks via static/dynamic preset refs above for cross-agent content.'}
					oninput={(e) =>
						onPatch({
							customSystemPrompt: (e.target as HTMLTextAreaElement).value
						})}
				/>
			</div>
		</div>

		<!-- BOUNDARY -->
		<div class="relative">
			<div class="flex items-center gap-2">
				<div class="h-0.5 flex-1 bg-rose-300/70 dark:bg-rose-800/60"></div>
				<div
					class="flex items-center gap-1.5 rounded-full border bg-background px-3 py-0.5 text-[10px] font-medium tracking-wide"
					class:text-emerald-600={cacheEligible}
					class:text-amber-600={!cacheEligible}
				>
					<Sparkles class="size-3" />
					BOUNDARY · {prefixChars}ch · {cacheEligible ? '✓ cache eligible' : `need ≥${CACHE_THRESHOLD_CHARS}ch`}
				</div>
				<div class="h-0.5 flex-1 bg-rose-300/70 dark:bg-rose-800/60"></div>
			</div>
		</div>

		<!-- DYNAMIC TAIL -->
		<div class="space-y-1.5 rounded-lg border bg-muted/10 p-3">
			<div class="mb-1 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
				<span>Dynamic tail</span>
				<span class="text-muted-foreground/60">per-turn ({tailChars}ch)</span>
			</div>

			<!-- Dynamic bindings -->
			{#each dynamicBindings as ref, i (ref.id + '@' + ref.version + ':' + i)}
				{@const info = bindingPreview(ref)}
				<div
					class="group flex items-center gap-2 rounded-md border bg-cyan-50/30 px-2 py-1.5 text-xs transition-colors hover:border-cyan-300 dark:bg-cyan-950/20"
					draggable="true"
					ondragstart={() => handleDragStart('dynamic', i)}
					ondragover={handleDragOver}
					ondrop={(e) => handleDrop(e, 'dynamic', i)}
					ondragend={handleDragEnd}
					role="listitem"
				>
					<GripVertical class="size-3.5 cursor-grab text-muted-foreground active:cursor-grabbing" />
					<Badge variant="outline" class="text-[10px]">bound</Badge>
					{#if info.preset}
						<span class="truncate font-medium">{info.preset.title}</span>
					{:else}
						<span class="italic text-amber-600">[preset {ref.id} not found]</span>
					{/if}
					<button
						type="button"
						class="rounded px-1 py-0.5 text-[10px] font-mono tabular-nums hover:bg-accent {info.isStale
							? 'text-amber-600'
							: 'text-muted-foreground'}"
						title={info.isStale
							? `Pinned to v${ref.version}. Latest is v${info.latestVersion}. Click to bump.`
							: `Pinned to v${ref.version}`}
						onclick={() => info.isStale && bumpVersion('dynamic', i)}
						disabled={!info.isStale}
					>
						v{ref.version}{info.isStale ? ` → v${info.latestVersion}` : ''}
					</button>
					<span class="ml-auto tabular-nums text-muted-foreground">
						{info.content.length}ch
					</span>
					<button
						type="button"
						class="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
						aria-label="Remove binding"
						onclick={() => removeBinding('dynamic', i)}
					>
						<X class="size-3" />
					</button>
				</div>
			{/each}

			<!-- Add dynamic binding -->
			<Popover.Root
				open={pickerKind === 'dynamic'}
				onOpenChange={(open) => {
					if (!open && pickerKind === 'dynamic') {
						pickerKind = null;
						pickerSearch = '';
					}
				}}
			>
				<Popover.Trigger>
					{#snippet child({ props })}
						<button
							{...props}
							type="button"
							class="flex w-full items-center justify-center gap-1 rounded-md border border-dashed px-3 py-1.5 text-xs text-muted-foreground hover:border-cyan-400 hover:bg-cyan-50/40 dark:hover:bg-cyan-950/20"
							onclick={() => (pickerKind = 'dynamic')}
						>
							<Plus class="size-3.5" /> Add dynamic preset
						</button>
					{/snippet}
				</Popover.Trigger>
				<Popover.Content class="w-80 p-0" align="start">
					<div class="border-b p-2">
						<div class="flex items-center gap-2">
							<Search class="size-3.5 text-muted-foreground" />
							<Input
								class="h-7 border-0 px-1 text-xs focus-visible:ring-0"
								placeholder="Search presets..."
								bind:value={pickerSearch}
							/>
						</div>
					</div>
					<div class="max-h-72 overflow-y-auto py-1">
						{#if loadingPresets}
							<div class="px-3 py-4 text-center text-xs text-muted-foreground">Loading...</div>
						{:else if pickerCandidates.length === 0}
							<div class="px-3 py-4 text-center text-xs text-muted-foreground">
								{availableForDynamic.length === 0 && presets.length > 0
									? 'All presets already bound here.'
									: presets.length === 0
									? 'No presets yet. Create one in Prompts.'
									: 'No matches.'}
							</div>
						{:else}
							{#each pickerCandidates as preset (preset.id)}
								<button
									type="button"
									class="flex w-full flex-col gap-0.5 px-3 py-2 text-left text-xs hover:bg-accent"
									onclick={() => addBinding('dynamic', preset.id)}
								>
									<div class="flex items-center justify-between">
										<span class="font-medium">{preset.title}</span>
										<span class="tabular-nums text-muted-foreground">
											v{preset.latestVersion?.version ?? preset.version} · {presetCharCount(preset)}ch
										</span>
									</div>
									{#if preset.description}
										<span class="line-clamp-1 text-muted-foreground">
											{preset.description}
										</span>
									{/if}
								</button>
							{/each}
						{/if}
					</div>
				</Popover.Content>
			</Popover.Root>

			<!-- System-provided dynamic sections -->
			<div class="flex items-center gap-2 rounded-md border border-dashed border-border/60 bg-background/50 px-3 py-1.5 text-xs">
				<Badge variant="outline" class="text-[10px]">system</Badge>
				<span class="font-medium">Runtime Context</span>
				<span class="ml-auto text-[10px] text-muted-foreground">cwd · sandbox · skills</span>
			</div>
			<div class="flex items-center gap-2 rounded-md border border-dashed border-border/60 bg-background/50 px-3 py-1.5 text-xs">
				<Badge variant="outline" class="text-[10px]">system</Badge>
				<span class="font-medium">Current Date</span>
				<span class="ml-auto font-mono text-[10px] text-muted-foreground">{previewToday}</span>
			</div>
			<div class="flex items-center gap-2 rounded-md border border-dashed border-border/60 bg-background/50 px-3 py-1.5 text-xs">
				<Badge variant="outline" class="text-[10px]">system</Badge>
				<span class="font-medium">Hook Context</span>
				<span class="ml-auto text-[10px] text-muted-foreground">SessionStart / UserPromptSubmit hooks</span>
			</div>
			<div class="flex items-center gap-2 rounded-md border border-dashed border-border/60 bg-background/50 px-3 py-1.5 text-xs">
				<Badge variant="outline" class="text-[10px]">system</Badge>
				<span class="font-medium">MCP Server Instructions</span>
				<span class="ml-auto text-[10px] text-muted-foreground">
					{Array.isArray(config.mcpServers) ? `${config.mcpServers.length} server(s)` : '0 servers'}
				</span>
			</div>

			<!-- Append system prompt -->
			<div class="rounded-md border border-amber-300/50 bg-amber-50/40 p-2 dark:border-amber-700/50 dark:bg-amber-950/10">
				<div class="mb-1.5 flex items-center gap-2 text-xs">
					<Badge variant="outline" class="text-[10px]">agent</Badge>
					<span class="font-medium">Append</span>
					<span class="ml-auto tabular-nums text-muted-foreground">
						{appendCharCount}ch
					</span>
				</div>
				<Textarea
					rows={2}
					class="text-xs"
					placeholder="Verbatim text appended at the very end of every prompt."
					value={config.appendSystemPrompt ?? ''}
					oninput={(e) =>
						onPatch({
							appendSystemPrompt: (e.target as HTMLTextAreaElement).value
						})}
				/>
			</div>
		</div>
	</div>

	<!-- Right: Live preview -->
	<div class="min-w-0">
		<div class="sticky top-0 space-y-2">
			<div class="flex items-center justify-between">
				<h3 class="text-sm font-semibold">Live preview</h3>
				<div class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
					<span class="tabular-nums">{prefixChars + tailChars}ch total</span>
					{#if cacheEligible}
						<Badge variant="outline" class="text-[10px] text-emerald-700">
							cached prefix
						</Badge>
					{/if}
				</div>
			</div>
			<pre
				class="max-h-[70vh] overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">{renderedSystem}</pre>
			<div class="text-[10px] text-muted-foreground">
				This is what the LLM sees as <code class="rounded bg-muted px-1">system</code>. The
				boundary marker is consumed by the Anthropic adapter — above the line is sent
				with <code class="rounded bg-muted px-1">cache_control: ephemeral</code> when ≥{CACHE_THRESHOLD_CHARS}ch.
			</div>
		</div>
	</div>
</div>

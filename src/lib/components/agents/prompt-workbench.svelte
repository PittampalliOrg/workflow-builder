<script lang="ts">
	import { onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Textarea } from '$lib/components/ui/textarea';
	import PromptPreview from '$lib/components/agents/prompt-preview.svelte';
	import type { AgentConfig, AgentDetail } from '$lib/types/agents';
	import type { PromptPresetSummary } from '$lib/types/prompt-presets';
	import {
		agentConfigPatchFromPreset,
		buildPromptWorkbenchPreview,
		createPresetPayloadFromConfig
	} from '$lib/agents/prompt-workbench-renderer';
	import { Database, History, Save, Upload } from '@lucide/svelte';

	interface Props {
		agent: AgentDetail;
		config: AgentConfig;
		onPatch: (patch: Partial<AgentConfig>) => void;
	}

	let { agent, config, onPatch }: Props = $props();
	let presets = $state<PromptPresetSummary[]>([]);
	let selectedPresetId = $state('');
	let loadingPresets = $state(false);
	let presetError = $state<string | null>(null);
	let savePresetOpen = $state(false);
	let presetName = $state('');
	let presetDescription = $state('');
	let savingPreset = $state(false);
	let updatingPreset = $state(false);

	const selectedPreset = $derived(
		presets.find((preset) => preset.id === selectedPresetId) ?? null
	);
	const preview = $derived(
		buildPromptWorkbenchPreview({
			config,
			agent: {
				id: agent.id,
				name: agent.name,
				slug: agent.slug,
				version: agent.currentVersion,
				configHash: agent.currentConfigHash
			},
			runtime: {
				cwd: config.cwd ?? '/sandbox',
				sandboxName: 'preview-sandbox',
				environment: agent.environmentId ?? 'default',
				skills: skillNames(config.skills)
			},
			preset: selectedPreset,
			userPrompt: 'Preview user task from the next session or workflow node.'
		})
	);

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
			if (!selectedPresetId && presets.length > 0) selectedPresetId = presets[0].id;
		} catch (err) {
			presetError = err instanceof Error ? err.message : String(err);
		} finally {
			loadingPresets = false;
		}
	}

	function applyPreset() {
		if (!selectedPreset) return;
		const patch = agentConfigPatchFromPreset(selectedPreset);
		onPatch(patch);
	}

	async function saveAsPreset() {
		if (!presetName.trim()) return;
		savingPreset = true;
		presetError = null;
		try {
			const payload = createPresetPayloadFromConfig({
				name: presetName.trim(),
				description: presetDescription.trim() || null,
				config
			});
			const res = await fetch('/api/prompt-presets', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				presetError = `Save preset failed (${res.status})`;
				return;
			}
			const data = (await res.json()) as { preset: PromptPresetSummary };
			presets = [data.preset, ...presets.filter((preset) => preset.id !== data.preset.id)];
			selectedPresetId = data.preset.id;
			savePresetOpen = false;
			presetName = '';
			presetDescription = '';
		} finally {
			savingPreset = false;
		}
	}

	async function updatePreset() {
		if (!selectedPreset) return;
		updatingPreset = true;
		presetError = null;
		try {
			const payload = createPresetPayloadFromConfig({
				name: selectedPreset.name,
				description: selectedPreset.description,
				config
			});
			const res = await fetch(`/api/prompt-presets/${selectedPreset.id}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			if (!res.ok) {
				presetError = `Update preset failed (${res.status})`;
				return;
			}
			const data = (await res.json()) as { preset: PromptPresetSummary };
			presets = presets.map((preset) => (preset.id === data.preset.id ? data.preset : preset));
		} finally {
			updatingPreset = false;
		}
	}

	function skillNames(value: unknown): string[] {
		if (!Array.isArray(value)) return [];
		return value
			.map((item) => {
				if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
				const record = item as Record<string, unknown>;
				return (
					textValue(record.name) ??
					textValue(record.skillName) ??
					textValue(record.skill_name) ??
					textValue(record.slug)
				);
			})
			.filter((name): name is string => Boolean(name));
	}

	function textValue(value: unknown): string | null {
		return typeof value === 'string' && value.trim() ? value.trim() : null;
	}
</script>

<div class="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(420px,0.9fr)]">
	<div class="min-w-0 space-y-4">
		<div class="rounded-md border bg-muted/20 p-4">
			<div class="mb-3 flex items-center justify-between gap-3">
				<div>
					<h3 class="text-sm font-semibold">Prompt Presets</h3>
					<div class="mt-1 flex flex-wrap gap-1.5">
						<Badge variant="outline" class="text-[10px]">Project scoped</Badge>
						<Badge variant="outline" class="text-[10px]">Mustache</Badge>
					</div>
				</div>
				<Button variant="outline" size="sm" disabled={loadingPresets} onclick={loadPresets}>
					<Database class="size-3.5" />
					{loadingPresets ? 'Loading...' : 'Refresh'}
				</Button>
			</div>

			{#if presetError}
				<Alert class="mb-3">
					<AlertDescription>{presetError}</AlertDescription>
				</Alert>
			{/if}

			<div class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
				<select
					class="min-w-0 rounded-md border bg-background px-3 py-2 text-sm"
					value={selectedPresetId}
					onchange={(e) => (selectedPresetId = (e.target as HTMLSelectElement).value)}
				>
					<option value="">No preset selected</option>
					{#each presets as preset}
						<option value={preset.id}>
							{preset.title} - v{preset.latestVersion?.version ?? preset.version}
						</option>
					{/each}
				</select>
				<div class="flex flex-wrap gap-2">
					<Button variant="outline" size="sm" disabled={!selectedPreset} onclick={applyPreset}>
						<Upload class="size-3.5" /> Apply preset
					</Button>
					<Dialog.Root bind:open={savePresetOpen}>
						<Dialog.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="outline" size="sm">
									<Save class="size-3.5" /> Save as preset
								</Button>
							{/snippet}
						</Dialog.Trigger>
						<Dialog.Content class="max-w-lg">
							<Dialog.Header>
								<Dialog.Title>Save prompt preset</Dialog.Title>
								<Dialog.Description>
									Creates a reusable project prompt from the current persona fields.
								</Dialog.Description>
							</Dialog.Header>
							<div class="space-y-3 py-2">
								<div>
									<Label for="preset-name">Name</Label>
									<Input id="preset-name" bind:value={presetName} placeholder="Code review preset" />
								</div>
								<div>
									<Label for="preset-description">Description</Label>
									<Textarea id="preset-description" rows={2} bind:value={presetDescription} />
								</div>
							</div>
							<Dialog.Footer>
								<Button variant="ghost" onclick={() => (savePresetOpen = false)}>Cancel</Button>
								<Button disabled={!presetName.trim() || savingPreset} onclick={saveAsPreset}>
									<Save class="size-4" />
									{savingPreset ? 'Saving...' : 'Save preset'}
								</Button>
							</Dialog.Footer>
						</Dialog.Content>
					</Dialog.Root>
					<Button variant="outline" size="sm" disabled={!selectedPreset || updatingPreset} onclick={updatePreset}>
						<History class="size-3.5" />
						{updatingPreset ? 'Updating...' : 'Update preset'}
					</Button>
				</div>
			</div>
			{#if selectedPreset}
				<div class="mt-2 text-xs text-muted-foreground">
					{selectedPreset.description ?? 'No description'}
					<span class="mx-1">/</span>
					<code>{selectedPreset.latestVersion?.templateHash?.slice(0, 12) ?? 'no hash'}</code>
				</div>
			{:else if presets.length === 0}
				<div class="mt-2 text-xs text-muted-foreground">
					No project presets yet.
				</div>
			{/if}
		</div>

		<div class="rounded-md border bg-background p-4">
			<h3 class="mb-3 text-sm font-semibold">Persona Fields</h3>
			<div class="grid gap-4">
				<div>
					<Label>Role</Label>
					<Input
						value={config.role ?? ''}
						placeholder="e.g. Senior Engineer"
						oninput={(e) => onPatch({ role: (e.target as HTMLInputElement).value })}
					/>
				</div>
				<div>
					<Label>Goal</Label>
					<Input
						value={config.goal ?? ''}
						placeholder="e.g. Help me ship features"
						oninput={(e) => onPatch({ goal: (e.target as HTMLInputElement).value })}
					/>
				</div>
				<div>
					<Label>System prompt</Label>
					<Textarea
						rows={8}
						value={config.systemPrompt ?? ''}
						oninput={(e) => onPatch({ systemPrompt: (e.target as HTMLTextAreaElement).value })}
					/>
				</div>
				<div>
					<Label>Instructions</Label>
					<Textarea
						rows={5}
						value={Array.isArray(config.instructions) ? config.instructions.join('\n') : ''}
						oninput={(e) =>
							onPatch({
								instructions: (e.target as HTMLTextAreaElement).value
									.split('\n')
									.map((line) => line.trim())
									.filter(Boolean)
							})}
					/>
				</div>
				<div>
					<Label>Style guidelines</Label>
					<Textarea
						rows={4}
						value={Array.isArray(config.styleGuidelines) ? config.styleGuidelines.join('\n') : ''}
						oninput={(e) =>
							onPatch({
								styleGuidelines: (e.target as HTMLTextAreaElement).value
									.split('\n')
									.map((line) => line.trim())
									.filter(Boolean)
							})}
					/>
				</div>
			</div>
		</div>
	</div>

	<div class="min-w-0">
		<PromptPreview {preview} />
	</div>
</div>

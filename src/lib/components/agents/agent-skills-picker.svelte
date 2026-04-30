<script lang="ts">
	import { onMount } from 'svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Loader2, Plus, RefreshCw, X } from '@lucide/svelte';
	import type { AgentSkillConfig } from '$lib/agent-skill-presets';

	interface Props {
		value: AgentSkillConfig[];
		onChange: (next: AgentSkillConfig[]) => void;
	}

	let { value, onChange }: Props = $props();

	let registry = $state<AgentSkillConfig[]>([]);
	let registryLoading = $state(false);
	let registryError = $state<string | null>(null);

	onMount(() => {
		void load();
	});

	async function load() {
		registryLoading = true;
		registryError = null;
		try {
			const res = await fetch('/api/agent-skills');
			if (!res.ok) {
				registryError = `Failed to load skill registry (${res.status})`;
				return;
			}
			const data = (await res.json()) as { skills: AgentSkillConfig[] };
			registry = data.skills ?? [];
		} catch (err) {
			registryError = err instanceof Error ? err.message : String(err);
		} finally {
			registryLoading = false;
		}
	}

	function skillKey(skill: AgentSkillConfig): string {
		return (skill.slug ?? skill.name ?? '').toLowerCase();
	}

	function isSelected(skill: AgentSkillConfig): boolean {
		const key = skillKey(skill);
		return value.some((s) => skillKey(s) === key);
	}

	let available = $derived(registry.filter((s) => !isSelected(s)));

	function addSkill(skill: AgentSkillConfig) {
		if (isSelected(skill)) return;
		onChange([...value, skill]);
	}

	function removeSkill(skill: AgentSkillConfig) {
		const key = skillKey(skill);
		onChange(value.filter((s) => skillKey(s) !== key));
	}

	function updateAllowedTools(skill: AgentSkillConfig, csv: string) {
		const allowedTools = csv
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		const key = skillKey(skill);
		onChange(
			value.map((s) =>
				skillKey(s) === key
					? { ...s, allowedTools: allowedTools.length > 0 ? allowedTools : undefined }
					: s
			)
		);
	}
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between gap-2">
		<p class="text-xs text-muted-foreground">
			Approved skills are installed into the agent runtime at startup.
		</p>
		<Button variant="outline" size="sm" onclick={() => void load()}>
			{#if registryLoading}
				<Loader2 class="size-3 animate-spin" />
			{:else}
				<RefreshCw class="size-3" />
			{/if}
			Refresh
		</Button>
	</div>

	{#if registryError}
		<div class="text-xs text-destructive">{registryError}</div>
	{/if}

	{#if available.length > 0}
		<div class="space-y-1.5">
			<p class="text-[11px] font-medium text-muted-foreground">Available</p>
			<div class="flex flex-wrap gap-2">
				{#each available as skill (skillKey(skill))}
					<Button variant="outline" size="sm" onclick={() => addSkill(skill)}>
						<Plus class="size-3" />
						{skill.name}
					</Button>
				{/each}
			</div>
		</div>
	{/if}

	<div class="space-y-2">
		<p class="text-[11px] font-medium text-muted-foreground">Selected ({value.length})</p>
		{#if value.length === 0}
			<div class="rounded border border-dashed p-3 text-xs text-muted-foreground">
				No skills selected. Add from the registry above.
			</div>
		{:else}
			<div class="space-y-2">
				{#each value as skill (skillKey(skill) || skill.name)}
					<div class="rounded border p-3 space-y-2">
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0 flex-1">
								<div class="flex flex-wrap items-center gap-2">
									<span class="font-medium text-sm truncate">{skill.name || 'Unnamed'}</span>
									{#if skill.version}
										<Badge variant="outline">v{skill.version}</Badge>
									{/if}
									{#if skill.sourceType}
										<Badge variant="secondary">{skill.sourceType}</Badge>
									{/if}
								</div>
								{#if skill.installSource || skill.sourceRepo}
									<code class="text-[10px] text-muted-foreground truncate block">
										{skill.installSource ?? skill.sourceRepo}@{skill.skillName ?? skill.name}
									</code>
								{/if}
								{#if skill.description}
									<p class="text-[11px] text-muted-foreground mt-1 line-clamp-2">
										{skill.description}
									</p>
								{/if}
							</div>
							<Button
								variant="ghost"
								size="icon"
								class="size-7"
								onclick={() => removeSkill(skill)}
							>
								<X class="size-3" />
							</Button>
						</div>
						<div>
							<Label for={`skill-tools-${skillKey(skill)}`} class="text-[11px]">
								Allowed tools (comma-separated; blank = all)
							</Label>
							<Input
								id={`skill-tools-${skillKey(skill)}`}
								value={(skill.allowedTools ?? []).join(', ')}
								oninput={(e) =>
									updateAllowedTools(skill, (e.target as HTMLInputElement).value)}
								placeholder="all tools"
							/>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

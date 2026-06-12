<script lang="ts" module>
	export type CapabilitySectionId =
		| 'builtinTools'
		| 'toolsIntegrations'
		| 'callableAgents'
		| 'repositories'
		| 'skills'
		| 'bundles'
		| 'hooks'
		| 'plugins';

	export const DEFAULT_CAPABILITY_SECTIONS: CapabilitySectionId[] = [
		'builtinTools',
		'toolsIntegrations',
		'callableAgents',
		'repositories',
		'skills',
		'bundles',
		'hooks',
		'plugins'
	];

	// The drawer's slimmer config surface (no builtin-tools toggle / repositories /
	// plugins — those stay agent-authoring concerns).
	export const SESSION_CAPABILITY_SECTIONS: CapabilitySectionId[] = [
		'toolsIntegrations',
		'skills',
		'bundles',
		'hooks',
		'callableAgents'
	];

	const BUILTIN_TOOLS = [
		'execute_command',
		'read_file',
		'write_file',
		'edit_file',
		'list_files',
		'grep_search'
	];
</script>

<script lang="ts">
	import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '$lib/components/ui/collapsible';
	import { Input } from '$lib/components/ui/input';
	import { ChevronDown, ChevronRight } from '@lucide/svelte';
	import AgentToolsIntegrations from '$lib/components/agents/tools-integrations/AgentToolsIntegrations.svelte';
	import AgentSkillsPicker from '$lib/components/agents/agent-skills-picker.svelte';
	import BundleRefsPicker from '$lib/components/capabilities/bundle-refs-picker.svelte';
	import AgentHooksEditor from '$lib/components/agents/agent-hooks-editor.svelte';
	import CallableAgentsPicker from '$lib/components/agents/callable-agents-picker.svelte';
	import RepositoriesEditor from '$lib/components/sessions/repositories-editor.svelte';
	import type { AgentConfig } from '$lib/types/agents';

	interface Props {
		config: AgentConfig;
		/** Apply a partial config patch (one key per section change). */
		onPatch: (patch: Partial<AgentConfig>) => void;
		projectId?: string | null;
		selfSlug?: string;
		/** Agent's default vault ids — passed to Tools & Integrations for resolution. */
		vaultIds?: string[];
		workspaceSlug?: string;
		sections?: CapabilitySectionId[];
		variant?: 'collapsible' | 'flat';
		/** Whether the first section starts expanded (collapsible variant only). */
		openFirst?: boolean;
	}

	let {
		config,
		onPatch,
		projectId = null,
		selfSlug,
		vaultIds = [],
		workspaceSlug,
		sections = DEFAULT_CAPABILITY_SECTIONS,
		variant = 'collapsible',
		openFirst = true
	}: Props = $props();

	function toggleBuiltinTool(tool: string) {
		const cur = config.builtinTools ?? [];
		const next = cur.includes(tool) ? cur.filter((t) => t !== tool) : [...cur, tool];
		onPatch({ builtinTools: next });
	}

	function label(id: CapabilitySectionId): string {
		switch (id) {
			case 'builtinTools': return 'Built-in tools';
			case 'toolsIntegrations': return 'Tools & Integrations';
			case 'callableAgents': return 'Callable agents';
			case 'repositories': return 'Repositories';
			case 'skills': return 'Skills';
			case 'bundles': return 'Capability bundles';
			case 'hooks': return 'Hooks';
			case 'plugins': return 'Plugins';
		}
	}

	function count(id: CapabilitySectionId): number | null {
		switch (id) {
			case 'builtinTools': return (config.builtinTools ?? []).length;
			case 'toolsIntegrations': return (config.mcpServers ?? []).length;
			case 'callableAgents': return (config.callableAgents ?? []).length;
			case 'repositories': return (config.repositories ?? []).length;
			case 'skills': return (config.skills ?? []).length;
			case 'bundles': return (config.bundleRefs ?? []).length;
			case 'plugins': return (config.plugins ?? []).length;
			case 'hooks': return null;
		}
	}
</script>

{#snippet body(id: CapabilitySectionId)}
	{#if id === 'builtinTools'}
		<div class="flex flex-wrap gap-2">
			{#each BUILTIN_TOOLS as tool (tool)}
				<button
					type="button"
					class="rounded border px-2 py-1 text-xs {(config.builtinTools ?? []).includes(tool)
						? 'border-primary bg-primary text-primary-foreground'
						: 'bg-muted hover:bg-muted/70'}"
					onclick={() => toggleBuiltinTool(tool)}
				>
					{tool}
				</button>
			{/each}
		</div>
	{:else if id === 'toolsIntegrations'}
		<AgentToolsIntegrations
			value={config.mcpServers ?? []}
			connectionMode={config.mcpConnectionMode ?? 'auto'}
			{vaultIds}
			onModeChange={(mode) => onPatch({ mcpConnectionMode: mode })}
			onChange={(next) => onPatch({ mcpServers: next })}
		/>
	{:else if id === 'callableAgents'}
		<CallableAgentsPicker
			value={config.callableAgents ?? []}
			selfSlug={selfSlug ?? ''}
			{projectId}
			onChange={(next) => onPatch({ callableAgents: next })}
		/>
	{:else if id === 'repositories'}
		<p class="mb-2 text-xs text-muted-foreground">
			GitHub repos cloned into this agent's sandbox before its first turn — for direct sessions and
			any workflow step that runs this agent. Private repos need an auth credential from your vaults.
		</p>
		<RepositoriesEditor
			workspaceSlug={workspaceSlug ?? ''}
			value={config.repositories ?? []}
			onChange={(next) => onPatch({ repositories: next })}
		/>
	{:else if id === 'skills'}
		<AgentSkillsPicker value={config.skills ?? []} onChange={(next) => onPatch({ skills: next })} />
	{:else if id === 'bundles'}
		<BundleRefsPicker
			value={config.bundleRefs ?? []}
			{projectId}
			onChange={(next) => onPatch({ bundleRefs: next })}
		/>
	{:else if id === 'hooks'}
		<AgentHooksEditor value={config.hooks} onChange={(next) => onPatch({ hooks: next })} />
	{:else if id === 'plugins'}
		<Input
			value={(config.plugins ?? []).join(', ')}
			placeholder="comma-separated plugin IDs"
			oninput={(e) => {
				const ids = (e.target as HTMLInputElement).value
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean);
				onPatch({ plugins: ids });
			}}
		/>
	{/if}
{/snippet}

<div class="space-y-4">
	{#each sections as id (id)}
		{@const c = count(id)}
		{#if variant === 'collapsible'}
			<Collapsible open={openFirst && id === sections[0]}>
				<CollapsibleTrigger
					class="flex w-full items-center gap-2 py-2 text-left text-sm font-semibold"
				>
					{#if openFirst && id === sections[0]}
						<ChevronDown class="size-4" />
					{:else}
						<ChevronRight class="size-4" />
					{/if}
					{label(id)}{#if c !== null} ({c}){/if}
				</CollapsibleTrigger>
				<CollapsibleContent class="pl-6">
					{@render body(id)}
				</CollapsibleContent>
			</Collapsible>
		{:else}
			<section>
				<h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					{label(id)}
				</h3>
				{@render body(id)}
			</section>
		{/if}
	{/each}
</div>

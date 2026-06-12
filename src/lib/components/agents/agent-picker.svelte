<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import * as Command from '$lib/components/ui/command';
	import { Check, ChevronsUpDown } from '@lucide/svelte';
	import type { AgentSummary } from '$lib/types/agents';

	interface Props {
		/** Selected agent id, or null. */
		value: string | null;
		/** Candidate agents (caller already fetches /api/agents). */
		agents: AgentSummary[];
		/** Fired with the id AND the full summary so callers can stamp version/slug. */
		onChange: (agentId: string, agent: AgentSummary) => void;
		disabled?: boolean;
		placeholder?: string;
		class?: string;
	}

	let {
		value,
		agents,
		onChange,
		disabled = false,
		placeholder = 'Select an agent…',
		class: className = ''
	}: Props = $props();

	let open = $state(false);
	const selected = $derived(agents.find((a) => a.id === value) ?? null);

	function select(a: AgentSummary) {
		onChange(a.id, a);
		open = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		{disabled}
		class={`flex w-full items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm transition-colors hover:bg-accent/50 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
	>
		<span class="min-w-0 flex-1 truncate text-left">
			{#if selected}
				{selected.avatar ?? '🤖'} {selected.name} — v{selected.currentVersion ?? '—'}
			{:else}
				<span class="text-muted-foreground">{placeholder}</span>
			{/if}
		</span>
		<ChevronsUpDown size={14} class="shrink-0 text-muted-foreground" />
	</Popover.Trigger>

	<Popover.Content class="w-[320px] p-0" align="start" sideOffset={6}>
		<Command.Root>
			<Command.Input placeholder="Search agents…" class="h-9" />
			<Command.List class="max-h-[300px]">
				<Command.Empty>No agents found.</Command.Empty>
				<Command.Group>
					{#each agents as a (a.id)}
						<Command.Item
							value={`${a.name} ${a.slug}`}
							onSelect={() => select(a)}
							class="flex items-center gap-2"
						>
							<span class="shrink-0">{a.avatar ?? '🤖'}</span>
							<div class="min-w-0 flex-1">
								<div class="truncate text-xs">{a.name}</div>
								<div class="truncate text-[10px] text-muted-foreground">
									v{a.currentVersion ?? '—'}{a.modelSpec ? ` · ${a.modelSpec}` : ''}
								</div>
							</div>
							{#if a.id === value}
								<Check size={14} class="shrink-0 text-primary" />
							{/if}
						</Command.Item>
					{/each}
				</Command.Group>
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>

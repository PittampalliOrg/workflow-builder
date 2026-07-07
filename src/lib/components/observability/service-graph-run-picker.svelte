<script lang="ts">
	/**
	 * Grouped, live-aware run picker for the service graph's Run view.
	 *
	 * Replaces the flat "Execution" dropdown: searchable combobox with a pinned
	 * "Live now" group (running/pending runs) followed by runs grouped per
	 * workflow, newest first — each row carrying a status dot + relative time.
	 */
	import * as Popover from '$lib/components/ui/popover';
	import * as Command from '$lib/components/ui/command';
	import { Check, ChevronsUpDown } from '@lucide/svelte';

	export type RunOption = {
		id: string;
		label: string;
		workflowId: string | null;
		workflowName: string;
		status: string;
		startedAt: string;
	};

	let {
		value,
		runs,
		onChange
	}: {
		value: string;
		runs: RunOption[];
		onChange: (id: string) => void;
	} = $props();

	let open = $state(false);
	const selected = $derived(runs.find((r) => r.id === value) ?? null);

	const ACTIVE = new Set(['running', 'pending']);
	const live = $derived(runs.filter((r) => ACTIVE.has(r.status)));
	const byWorkflow = $derived.by(() => {
		const groups = new Map<string, RunOption[]>();
		for (const r of runs) {
			if (ACTIVE.has(r.status)) continue; // already pinned in "Live now"
			const key = r.workflowName;
			(groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
		}
		return [...groups.entries()];
	});

	function statusDot(status: string): string {
		if (status === 'running' || status === 'pending') return 'bg-primary animate-pulse';
		if (status === 'success') return 'bg-emerald-400';
		if (status === 'error') return 'bg-destructive';
		return 'bg-muted-foreground/50';
	}

	function relTime(iso: string): string {
		const ms = Date.now() - Date.parse(iso);
		if (!Number.isFinite(ms) || ms < 0) return '';
		const m = Math.floor(ms / 60000);
		if (m < 1) return 'just now';
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		return `${Math.floor(h / 24)}d ago`;
	}

	function select(id: string) {
		onChange(id);
		open = false;
	}
</script>

{#snippet runRow(r: RunOption, showWorkflow: boolean)}
	<Command.Item
		value={`${r.workflowName} ${r.id} ${r.status}`}
		onSelect={() => select(r.id)}
		class="flex items-center gap-2"
	>
		<span class="size-2 shrink-0 rounded-full {statusDot(r.status)}"></span>
		<div class="min-w-0 flex-1">
			<div class="truncate text-xs">
				{#if showWorkflow}{r.workflowName} · {/if}<span class="font-mono text-[11px]">{r.id.slice(0, 8)}</span>
			</div>
			<div class="truncate text-[10px] text-muted-foreground">{r.status} · {relTime(r.startedAt)}</div>
		</div>
		{#if r.id === value}<Check class="size-3.5 shrink-0 text-primary" />{/if}
	</Command.Item>
{/snippet}

<Popover.Root bind:open>
	<Popover.Trigger
		class="flex min-w-[280px] items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm transition-colors hover:bg-accent/50"
	>
		{#if selected}
			<span class="size-2 shrink-0 rounded-full {statusDot(selected.status)}"></span>
			<span class="min-w-0 flex-1 truncate text-left text-xs">
				{selected.workflowName} · <span class="font-mono text-[11px]">{selected.id.slice(0, 8)}</span>
				<span class="text-muted-foreground"> · {selected.status} · {relTime(selected.startedAt)}</span>
			</span>
		{:else}
			<span class="flex-1 truncate text-left text-xs text-muted-foreground">Pick a run…</span>
		{/if}
		<ChevronsUpDown size={14} class="shrink-0 text-muted-foreground" />
	</Popover.Trigger>

	<Popover.Content class="w-[360px] p-0" align="start" sideOffset={6}>
		<Command.Root>
			<Command.Input placeholder="Search runs by workflow…" class="h-9" />
			<Command.List class="max-h-[340px]">
				<Command.Empty>No runs found.</Command.Empty>
				{#if live.length > 0}
					<Command.Group heading="Live now">
						{#each live as r (r.id)}
							{@render runRow(r, true)}
						{/each}
					</Command.Group>
				{/if}
				{#each byWorkflow as [workflow, rows] (workflow)}
					<Command.Group heading={workflow}>
						{#each rows as r (r.id)}
							{@render runRow(r, false)}
						{/each}
					</Command.Group>
				{/each}
			</Command.List>
		</Command.Root>
	</Popover.Content>
</Popover.Root>

<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import * as Command from '$lib/components/ui/command';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Check, ChevronsUpDown, X } from 'lucide-svelte';

	type Option = { value: string; label: string; count?: number };

	type Props = {
		options: Option[];
		selected: string[];
		onChange: (next: string[]) => void;
		placeholder?: string;
		label?: string;
		emptyText?: string;
		/** Max chips to render before showing "+N more". */
		maxChips?: number;
		class?: string;
	};

	let {
		options,
		selected,
		onChange,
		placeholder = 'Select…',
		label = 'Select',
		emptyText = 'No matches.',
		maxChips = 3,
		class: className = ''
	}: Props = $props();

	let open = $state(false);
	let search = $state('');

	const selectedSet = $derived(new Set(selected));
	const filtered = $derived(
		search.trim()
			? options.filter((o) => o.label.toLowerCase().includes(search.trim().toLowerCase()))
			: options
	);
	const visibleChips = $derived(selected.slice(0, maxChips));
	const overflowCount = $derived(Math.max(0, selected.length - maxChips));

	function toggle(value: string) {
		const next = selectedSet.has(value)
			? selected.filter((v) => v !== value)
			: [...selected, value];
		onChange(next);
	}

	function removeChip(value: string) {
		onChange(selected.filter((v) => v !== value));
	}

	function clearAll() {
		onChange([]);
	}
</script>

<div class="flex flex-wrap items-center gap-1.5 {className}">
	<Popover.Root bind:open>
		<Popover.Trigger class="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs font-medium hover:bg-muted/40 transition-colors">
			<span class="text-muted-foreground">{label}</span>
			{#if selected.length > 0}
				<span class="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
					{selected.length}
				</span>
			{/if}
			<ChevronsUpDown class="ml-0.5 h-3 w-3 text-muted-foreground" />
		</Popover.Trigger>
		<Popover.Content class="w-[280px] p-0" align="start" sideOffset={6}>
			<Command.Root>
				<Command.Input bind:value={search} {placeholder} class="h-9" />
				<Command.List class="max-h-[260px]">
					<Command.Empty>{emptyText}</Command.Empty>
					<Command.Group>
						{#each filtered as opt (opt.value)}
							{@const isSelected = selectedSet.has(opt.value)}
							<Command.Item
								value={opt.label}
								onSelect={() => toggle(opt.value)}
								class="flex items-center justify-between gap-2"
							>
								<span class="flex items-center gap-2 min-w-0">
									<span class="flex h-4 w-4 items-center justify-center rounded-sm border {isSelected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}">
										{#if isSelected}
											<Check class="h-3 w-3" />
										{/if}
									</span>
									<span class="truncate text-xs">{opt.label}</span>
								</span>
								{#if typeof opt.count === 'number'}
									<span class="text-[10px] tabular-nums text-muted-foreground">{opt.count}</span>
								{/if}
							</Command.Item>
						{/each}
					</Command.Group>
				</Command.List>
				{#if selected.length > 0}
					<div class="flex items-center justify-between border-t border-border px-2 py-1.5 text-xs">
						<span class="text-muted-foreground">{selected.length} selected</span>
						<Button variant="ghost" size="sm" class="h-6 px-2 text-xs" onclick={clearAll}>
							Clear
						</Button>
					</div>
				{/if}
			</Command.Root>
		</Popover.Content>
	</Popover.Root>

	{#each visibleChips as value (value)}
		{@const opt = options.find((o) => o.value === value)}
		<Badge variant="secondary" class="h-6 gap-1 pl-2 pr-1 text-[11px] font-medium">
			<span class="truncate max-w-[140px]">{opt?.label ?? value}</span>
			<button
				type="button"
				onclick={() => removeChip(value)}
				class="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-muted-foreground/20"
				aria-label="Remove {opt?.label ?? value}"
			>
				<X class="h-3 w-3" />
			</button>
		</Badge>
	{/each}
	{#if overflowCount > 0}
		<Badge variant="secondary" class="h-6 px-2 text-[11px]">
			+{overflowCount} more
		</Badge>
	{/if}
</div>

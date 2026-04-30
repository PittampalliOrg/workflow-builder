<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import {
		DropdownMenu,
		DropdownMenuContent,
		DropdownMenuItem,
		DropdownMenuSeparator,
		DropdownMenuTrigger
	} from '$lib/components/ui/dropdown-menu';
	import { MoreHorizontal } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	interface Action {
		label: string;
		icon?: Snippet;
		onClick: () => void | Promise<void>;
		/** Render as destructive (red) — used for Archive/Delete. */
		destructive?: boolean;
		/** Separator line above this item. */
		separator?: boolean;
		disabled?: boolean;
	}

	interface Props {
		actions: Action[];
		ariaLabel?: string;
	}

	let { actions, ariaLabel = 'More actions' }: Props = $props();
</script>

<DropdownMenu>
	<DropdownMenuTrigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon"
				class="size-7"
				aria-label={ariaLabel}
				onclick={(e) => e.stopPropagation()}
			>
				<MoreHorizontal class="size-4" />
			</Button>
		{/snippet}
	</DropdownMenuTrigger>
	<DropdownMenuContent align="end" class="w-40">
		{#each actions as action, i (action.label)}
			{#if action.separator && i > 0}
				<DropdownMenuSeparator />
			{/if}
			<DropdownMenuItem
				disabled={action.disabled}
				onSelect={() => action.onClick()}
				class={action.destructive ? 'text-destructive focus:text-destructive' : ''}
			>
				{#if action.icon}{@render action.icon()}{/if}
				{action.label}
			</DropdownMenuItem>
		{/each}
	</DropdownMenuContent>
</DropdownMenu>

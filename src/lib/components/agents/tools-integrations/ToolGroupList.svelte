<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Switch } from '$lib/components/ui/switch';
	import { Lock } from '@lucide/svelte';
	import type { PieceMetadataAction } from '$lib/server/mcp-catalog';

	interface Props {
		/** Group heading (e.g. "Read-only", "Write"). */
		title: string;
		/** The actions in this group (already filtered + classified by the parent). */
		actions: PieceMetadataAction[];
		/** Tools currently ON for THIS consumer (project page or one agent). */
		enabled: Set<string>;
		/**
		 * The ceiling for THIS consumer: tools NOT in the ceiling render
		 * greyed/locked + non-toggleable. `null` = unbounded (no ceiling —
		 * every action is selectable). The piece detail page passes `null`
		 * because it IS the ceiling.
		 */
		ceiling: Set<string> | null;
		/** Optional deep-link rendered next to greyed tools ("Manage ↗"). */
		manageHref?: string;
		busy?: boolean;
		disabled?: boolean;
		onToolToggle: (name: string, checked: boolean) => void;
		onGroupToggle: (actions: PieceMetadataAction[], checked: boolean) => void;
	}

	let {
		title,
		actions,
		enabled,
		ceiling,
		manageHref,
		busy = false,
		disabled = false,
		onToolToggle,
		onGroupToggle
	}: Props = $props();

	function inCeiling(name: string): boolean {
		return ceiling === null || ceiling.has(name);
	}

	/** Actions this consumer is allowed to toggle (within the ceiling). */
	const selectableActions = $derived(actions.filter((action) => inCeiling(action.name)));
	const enabledInGroup = $derived(
		selectableActions.filter((action) => enabled.has(action.name)).length
	);
	const groupControlsDisabled = $derived(disabled || busy || selectableActions.length === 0);
</script>

<div class="space-y-2">
	<div class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-2">
			<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
			<Badge variant="outline" class="text-[10px]">
				{enabledInGroup}/{selectableActions.length}
			</Badge>
		</div>
		<div class="flex items-center gap-1">
			<Button
				variant="ghost"
				size="sm"
				class="h-6 px-2 text-[11px]"
				disabled={groupControlsDisabled}
				onclick={() => onGroupToggle(selectableActions, true)}
			>
				Enable all
			</Button>
			<Button
				variant="ghost"
				size="sm"
				class="h-6 px-2 text-[11px]"
				disabled={groupControlsDisabled}
				onclick={() => onGroupToggle(selectableActions, false)}
			>
				Disable all
			</Button>
		</div>
	</div>
	<div class="rounded-md border divide-y">
		{#if actions.length === 0}
			<div class="p-3 text-xs text-muted-foreground">No matching tools.</div>
		{:else}
			{#each actions as action (action.name)}
				{@const locked = !inCeiling(action.name)}
				<div
					class="p-2.5 flex items-center justify-between gap-3 {locked ? 'opacity-55' : ''}"
				>
					<div class="min-w-0">
						<div class="flex items-center gap-2 flex-wrap">
							<span class="text-sm font-medium truncate">{action.displayName}</span>
							<code class="text-[10px] text-muted-foreground">{action.name}</code>
							{#if locked}
								<Badge variant="outline" class="text-[10px] gap-1">
									<Lock class="size-2.5" /> disabled for workspace
								</Badge>
								{#if manageHref}
									<a
										class="text-[10px] underline text-muted-foreground hover:text-foreground"
										href={manageHref}
										target="_blank"
										rel="noreferrer"
									>
										Manage ↗
									</a>
								{/if}
							{/if}
						</div>
						{#if action.description}
							<p class="text-xs text-muted-foreground truncate">{action.description}</p>
						{/if}
					</div>
					<Switch
						checked={!locked && enabled.has(action.name)}
						disabled={disabled || busy || locked}
						onCheckedChange={(checked) => onToolToggle(action.name, checked)}
					/>
				</div>
			{/each}
		{/if}
	</div>
</div>

<!--
  One member node in the TeamPulse topology: identity-colored initials avatar
  with a status aura, name + current-task caption, hover mini-pulse, click to
  select (run consoles) or navigate (session detail).

  Status auras: working = pulsing ring in the member color; idle = dimmed;
  suspended = indigo ring + Moon glyph (hibernating — any message wakes it);
  shutdown = grayscale + struck name.
-->
<script lang="ts">
	import { Crown, Moon, TriangleAlert } from '@lucide/svelte';
	import * as HoverCard from '$lib/components/ui/hover-card';
	import { Badge } from '$lib/components/ui/badge';
	import { memberColor, memberInitials } from './member-color';

	interface Props {
		name: string;
		role: string;
		status: string;
		sessionId: string;
		currentTaskTitle?: string | null;
		selected?: boolean;
		onSelect?: (m: { name: string; sessionId: string }) => void;
		href?: string | null;
	}
	let {
		name,
		role,
		status,
		sessionId,
		currentTaskTitle = null,
		selected = false,
		onSelect,
		href = null
	}: Props = $props();

	const color = $derived(memberColor(role === 'lead' ? 'lead' : name));
	const isLead = $derived(role === 'lead');
	const aura = $derived.by(() => {
		if (status === 'working') return `team-aura-working border-2 ${color.ring}`;
		if (status === 'suspended') return 'border-2 border-indigo-400/60';
		if (status === 'failed') return 'border-2 border-red-400/70';
		if (status === 'shutdown') return 'border border-border grayscale';
		return `border ${color.ring} opacity-60`; // idle
	});
	const caption = $derived(
		currentTaskTitle ? currentTaskTitle : isLead ? 'coordinating' : status
	);
	const interactive = $derived(!!onSelect || !!href);
</script>

<HoverCard.Root openDelay={250}>
	<HoverCard.Trigger>
		{#snippet child({ props })}
			<svelte:element
				this={href ? 'a' : 'button'}
				{...props}
				{...href ? { href } : { type: 'button' }}
				class="group flex w-24 flex-col items-center gap-1 rounded-lg p-1.5 text-center transition
					{interactive ? 'cursor-pointer hover:bg-accent/40' : 'cursor-default'}
					{selected ? 'bg-primary/10 ring-1 ring-primary/40' : ''}"
				onclick={() => onSelect?.({ name, sessionId })}
				data-member={name}
			>
				<span class="relative flex size-10 items-center justify-center rounded-full {color.bg} {aura} transition-all duration-500">
					<span class="text-xs font-bold {status === 'shutdown' ? 'text-muted-foreground' : color.text}">
						{memberInitials(name)}
					</span>
					{#if isLead}
						<Crown class="absolute -top-2 left-1/2 size-3.5 -translate-x-1/2 text-amber-400" />
					{/if}
					{#if status === 'suspended'}
						<span class="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-indigo-500/90">
							<Moon class="size-2.5 text-white" />
						</span>
					{/if}
					{#if status === 'failed'}
						<span class="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-red-500/90">
							<TriangleAlert class="size-2.5 text-white" />
						</span>
					{/if}
					{#if status === 'working'}
						<span class="absolute -right-0.5 -bottom-0.5 size-2.5 animate-pulse rounded-full {color.dot} ring-2 ring-background"></span>
					{/if}
				</span>
				<span class="w-full truncate text-[11px] font-medium leading-tight {status === 'shutdown' ? 'text-muted-foreground line-through' : ''}">
					{name}
				</span>
				<span class="w-full truncate text-[9px] leading-tight text-muted-foreground" title={caption}>
					{caption}
				</span>
			</svelte:element>
		{/snippet}
	</HoverCard.Trigger>
	<HoverCard.Content class="w-64" side="bottom">
		<div class="space-y-1.5">
			<div class="flex items-center gap-2">
				<span class="size-2.5 rounded-full {color.dot}"></span>
				<span class="text-sm font-semibold">{name}</span>
				<Badge variant="outline" class="ml-auto text-[10px]">{role}</Badge>
			</div>
			<div class="flex items-center gap-2 text-xs text-muted-foreground">
				<span class="capitalize">{status}</span>
				{#if status === 'suspended'}
					<span class="text-indigo-300">· hibernating — any message wakes it</span>
				{:else if status === 'failed'}
					<span class="text-red-300">· errored — the lead can revive it</span>
				{/if}
			</div>
			{#if currentTaskTitle}
				<div class="text-xs"><span class="text-muted-foreground">on</span> {currentTaskTitle}</div>
			{/if}
			<div class="truncate text-[10px] text-muted-foreground/70">{sessionId}</div>
		</div>
	</HoverCard.Content>
</HoverCard.Root>

<style>
	:global(.team-aura-working) {
		animation: team-aura 2s ease-in-out infinite;
	}
	@keyframes team-aura {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgb(94 234 212 / 0.25);
		}
		50% {
			box-shadow: 0 0 0 6px rgb(94 234 212 / 0);
		}
	}
</style>

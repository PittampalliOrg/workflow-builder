<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Search } from 'lucide-svelte';

	interface Props {
		title: string;
		subtitle: string;
		itemLabel: string; // singular, e.g. "agent" — plural is auto-suffixed with "s"
		itemCount: number;
		searchPlaceholder?: string;
		onSearch: (value: string) => void;
		primaryLabel: string;
		onPrimary: () => void;
		loading: boolean;
		errorMessage: string | null;
		isEmpty: boolean;
		content: Snippet;
		filters?: Snippet;
		empty: Snippet;
		actions?: Snippet;
	}

	let {
		title,
		subtitle,
		itemLabel,
		itemCount,
		searchPlaceholder = 'Search…',
		onSearch,
		primaryLabel,
		onPrimary,
		loading,
		errorMessage,
		isEmpty,
		content,
		filters,
		empty,
		actions
	}: Props = $props();

	// Local search state kept inside the shell — parent observes via onSearch.
	// Dropping $bindable avoids a Svelte 5 effect loop under certain binding
	// chains where Input's bind:value flows back through bindable props.
	let localSearch = $state('');
</script>

<div class="flex flex-col gap-6 p-6 max-w-7xl mx-auto w-full">
	<header class="flex items-start justify-between gap-4 flex-wrap">
		<div>
			<h1 class="text-2xl font-semibold">{title}</h1>
			<p class="text-sm text-muted-foreground mt-1">{subtitle}</p>
			<p class="text-xs text-muted-foreground mt-0.5">
				{itemCount}
				{itemLabel}{itemCount === 1 ? '' : 's'}
			</p>
		</div>
		<div class="flex items-center gap-2">
			<div class="relative">
				<Search class="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
				<Input
					placeholder={searchPlaceholder}
					class="pl-9 w-72"
					bind:value={localSearch}
					oninput={(e) => onSearch((e.target as HTMLInputElement).value)}
				/>
			</div>
			{#if actions}
				{@render actions()}
			{/if}
			<Button onclick={onPrimary}>{primaryLabel}</Button>
		</div>
	</header>

	{#if filters}
		{@render filters()}
	{/if}

	{#if errorMessage}
		<Alert variant="destructive">
			<AlertDescription>{errorMessage}</AlertDescription>
		</Alert>
	{/if}

	{#if loading}
		<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
			{#each Array(6) as _, i (i)}
				<Skeleton class="h-40" />
			{/each}
		</div>
	{:else if isEmpty}
		{@render empty()}
	{:else}
		{@render content()}
	{/if}
</div>

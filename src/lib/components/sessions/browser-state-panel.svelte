<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { Badge } from '$lib/components/ui/badge';

	let { sessionId }: { sessionId: string } = $props();

	type ConsoleMsg = { level: string; text: string };
	type BrowserState = {
		pageUrl: string | null;
		pageTitle: string | null;
		consoleTail: ConsoleMsg[];
		lastUpdatedAt: string;
	};

	let frameTick = $state(Date.now());
	let browserState = $state<BrowserState | null>(null);
	let stateErr = $state<string | null>(null);
	let loadingState = $state(true);
	let frameTimer: ReturnType<typeof setInterval> | null = null;
	let stateTimer: ReturnType<typeof setInterval> | null = null;
	let consoleOpen = $state(false);

	const FRAME_INTERVAL_MS = 1000;
	const STATE_INTERVAL_MS = 2000;

	async function refreshState() {
		try {
			const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/browser/state`, {
				credentials: 'include',
			});
			if (res.status === 503) {
				stateErr = 'Browser not ready yet';
				return;
			}
			if (!res.ok) {
				stateErr = `${res.status} ${res.statusText}`;
				return;
			}
			browserState = (await res.json()) as BrowserState;
			stateErr = null;
		} catch (e) {
			stateErr = e instanceof Error ? e.message : String(e);
		} finally {
			loadingState = false;
		}
	}

	onMount(() => {
		frameTimer = setInterval(() => (frameTick = Date.now()), FRAME_INTERVAL_MS);
		void refreshState();
		stateTimer = setInterval(() => void refreshState(), STATE_INTERVAL_MS);
	});

	onDestroy(() => {
		if (frameTimer) clearInterval(frameTimer);
		if (stateTimer) clearInterval(stateTimer);
	});

	const screenshotSrc = $derived(
		`/api/v1/sessions/${encodeURIComponent(sessionId)}/browser/screenshot?t=${frameTick}`,
	);
	const hasConsoleMessages = $derived((browserState?.consoleTail?.length ?? 0) > 0);
</script>

<div class="flex h-full flex-col gap-2">
	<!-- page status row -->
	<div class="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
		<span
			class="inline-block size-2 shrink-0 rounded-full {stateErr
				? 'bg-red-500'
				: loadingState
					? 'bg-amber-500 animate-pulse'
					: 'bg-emerald-500'}"
			aria-hidden="true"
		></span>
		{#if browserState?.pageUrl}
			<span class="truncate font-mono text-muted-foreground">{browserState.pageUrl}</span>
		{:else if stateErr}
			<span class="text-red-500">{stateErr}</span>
		{:else}
			<span class="text-muted-foreground">Waiting for page…</span>
		{/if}
		<div class="ml-auto flex items-center gap-2">
			{#if browserState?.pageTitle}
				<span class="truncate text-muted-foreground max-w-[240px]">{browserState.pageTitle}</span>
			{/if}
			{#if hasConsoleMessages}
				<Badge variant="secondary" class="cursor-pointer" onclick={() => (consoleOpen = !consoleOpen)}>
					{browserState?.consoleTail.length} console
				</Badge>
			{/if}
		</div>
	</div>

	<!-- framebuffer -->
	<div class="flex-1 flex items-center justify-center overflow-hidden rounded-md border bg-black">
		<img
			src={screenshotSrc}
			alt="Agent browser screenshot"
			class="max-h-full max-w-full object-contain"
			loading="eager"
			decoding="async"
		/>
	</div>

	<!-- console tail (collapsible) -->
	{#if consoleOpen && hasConsoleMessages}
		<div class="rounded-md border bg-muted/20">
			<ScrollArea class="h-32 font-mono text-[11px]">
				<ul class="divide-y divide-border/40">
					{#each browserState?.consoleTail ?? [] as msg, idx (idx)}
						<li class="flex gap-2 px-2 py-1">
							<span
								class="shrink-0 w-12 uppercase {msg.level === 'error'
									? 'text-red-400'
									: msg.level === 'warning'
										? 'text-amber-400'
										: 'text-muted-foreground'}"
							>
								{msg.level}
							</span>
							<span class="truncate">{msg.text}</span>
						</li>
					{/each}
				</ul>
			</ScrollArea>
		</div>
	{/if}
</div>

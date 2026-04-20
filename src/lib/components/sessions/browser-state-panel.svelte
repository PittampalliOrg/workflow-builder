<script lang="ts">
	import { untrack } from 'svelte';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import { Badge } from '$lib/components/ui/badge';

	type Props = { sessionId: string };
	let { sessionId }: Props = $props();

	type ConsoleMsg = { level: string; text: string };
	type BrowserState = {
		pageUrl: string | null;
		pageTitle: string | null;
		consoleTail: ConsoleMsg[];
		lastUpdatedAt: string;
	};

	const FRAME_INTERVAL_MS = 1000;
	const STATE_INTERVAL_MS = 2000;

	// Holds the displayed src. Each new frame is fetched as a Blob and
	// exposed via URL.createObjectURL so the <img> assignment resolves
	// instantly from memory — no second network fetch (the screenshot
	// endpoint sends Cache-Control: no-store, which was causing the
	// previous-frame flicker with a plain <img src> swap). The previous
	// object URL is revoked after the new frame paints.
	let displaySrc = $state<string>('');
	let frameFetching = false;
	let previousObjectUrl: string | null = null;
	let browserState = $state<BrowserState | null>(null);
	let stateErr = $state<string | null>(null);
	let loadingState = $state(true);
	let consoleOpen = $state(false);

	async function bumpFrame() {
		if (frameFetching) return;
		frameFetching = true;
		try {
			const res = await fetch(
				`/api/v1/sessions/${encodeURIComponent(sessionId)}/browser/screenshot?t=${Date.now()}`,
				{ credentials: 'include' },
			);
			if (!res.ok) return;
			const blob = await res.blob();
			const nextUrl = URL.createObjectURL(blob);
			const prev = previousObjectUrl;
			previousObjectUrl = nextUrl;
			displaySrc = nextUrl;
			// Revoke the previous URL one tick after the src swap so the
			// paint has landed. Safari can otherwise hit a decoded blob
			// that's been torn down mid-paint.
			if (prev) {
				requestAnimationFrame(() => URL.revokeObjectURL(prev));
			}
		} catch {
			// Keep the last frame; next tick will retry.
		} finally {
			frameFetching = false;
		}
	}

	async function refreshState() {
		try {
			const res = await fetch(
				`/api/v1/sessions/${encodeURIComponent(sessionId)}/browser/state`,
				{ credentials: 'include' },
			);
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

	// Lifecycle via $effect with a single return-based teardown.
	$effect(() => {
		// Kick off the first frame + state fetch immediately so there's no
		// visible delay before the panel populates.
		untrack(() => {
			void bumpFrame();
			void refreshState();
		});
		const frameTimer = setInterval(() => void bumpFrame(), FRAME_INTERVAL_MS);
		const stateTimer = setInterval(() => void refreshState(), STATE_INTERVAL_MS);
		return () => {
			clearInterval(frameTimer);
			clearInterval(stateTimer);
			if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
		};
	});

	const hasConsoleMessages = $derived((browserState?.consoleTail?.length ?? 0) > 0);
	const statusTone = $derived(
		stateErr
			? 'bg-red-500'
			: loadingState
				? 'bg-amber-500 animate-pulse'
				: 'bg-emerald-500',
	);
</script>

<div class="flex h-full flex-col gap-2">
	<!-- page status row -->
	<div class="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
		<span
			class="inline-block size-2 shrink-0 rounded-full {statusTone}"
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
				<Badge
					variant="secondary"
					class="cursor-pointer"
					onclick={() => (consoleOpen = !consoleOpen)}
				>
					{browserState?.consoleTail.length} console
				</Badge>
			{/if}
		</div>
	</div>

	<!-- framebuffer -->
	<div class="flex-1 flex items-center justify-center overflow-hidden rounded-md border bg-black">
		{#if displaySrc}
			<img
				src={displaySrc}
				alt="Agent browser screenshot"
				class="max-h-full max-w-full object-contain"
				loading="eager"
				decoding="async"
				aria-live="polite"
			/>
		{:else}
			<span class="text-xs text-muted-foreground">Loading first frame…</span>
		{/if}
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

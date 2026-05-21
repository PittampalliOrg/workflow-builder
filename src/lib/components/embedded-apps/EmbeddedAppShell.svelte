<script lang="ts">
	import { onMount, untrack } from "svelte";
	import {
		ArrowLeft,
		ExternalLink,
		Fullscreen,
		PanelLeft,
		RefreshCw,
		type Icon,
	} from "@lucide/svelte";

	import { Button } from "$lib/components/ui/button";
	import * as Tooltip from "$lib/components/ui/tooltip";
	import {
		EMBED_CHROME_NATIVE,
		EMBED_CHROME_UNIFIED,
		embeddedAppSrc,
		normalizeEmbeddedAppPath,
		withEmbeddedAppChrome,
	} from "$lib/embedded-apps/links";

	export type EmbeddedAppNavItem = {
		id: string;
		label: string;
		icon: typeof Icon;
		path: string;
		match?: (path: string) => boolean;
	};

	type Props = {
		workspaceSlug: string;
		title: string;
		frameTitle: string;
		appIcon: typeof Icon;
		appIconLabel: string;
		defaultEmbedBase: string;
		embedBase: string;
		path: string;
		externalHref: string | null;
		externalLabel: string;
		nativeChromeLabel: string;
		reloadLabel: string;
		navItems: EmbeddedAppNavItem[];
		pathLabel: (path: string) => string;
		unifiedCss: string;
	};

	let {
		workspaceSlug,
		title,
		frameTitle,
		appIcon: AppIcon,
		appIconLabel,
		defaultEmbedBase,
		embedBase,
		path,
		externalHref,
		externalLabel,
		nativeChromeLabel,
		reloadLabel,
		navItems,
		pathLabel,
		unifiedCss,
	}: Props = $props();

	let currentPath = $state(untrack(() => normalizePath(path)));
	let frameKey = $state(0);
	let nativeChrome = $state(false);
	let iframeEl = $state<HTMLIFrameElement | null>(null);
	let pendingNavigationPath = $state<string | null>(null);

	const iframeSrc = $derived(
		withEmbeddedAppChrome({
			src: embeddedAppSrc({ embedBase, defaultEmbedBase, path: currentPath }),
			chrome: nativeChrome ? EMBED_CHROME_NATIVE : EMBED_CHROME_UNIFIED,
		}),
	);
	const currentPathLabel = $derived(pathLabel(currentPath));

	function normalizePath(value: string | null | undefined) {
		return normalizeEmbeddedAppPath({ value, embedBase });
	}

	function itemActive(item: EmbeddedAppNavItem) {
		return item.match ? item.match(currentPath) : currentPath === item.path;
	}

	function replaceOuterUrl(nextPath: string) {
		if (typeof window === "undefined") return;
		const next = new URL(window.location.href);
		next.searchParams.set("path", normalizePath(nextPath));
		window.history.replaceState(window.history.state, "", `${next.pathname}?${next.searchParams}`);
	}

	function pathMatchesPendingNavigation(actualPath: string, expectedPath: string) {
		try {
			const actual = new URL(actualPath, "http://workflow-builder.local");
			const expected = new URL(expectedPath, "http://workflow-builder.local");
			if (actual.pathname !== expected.pathname) return false;
			if (expected.hash && actual.hash !== expected.hash) return false;
			for (const [key, value] of expected.searchParams) {
				if (actual.searchParams.get(key) !== value) return false;
			}
			const defaultQueryParams = new Set([
				"showFavorites",
				"proj",
				"sync",
				"autoSync",
				"health",
				"namespace",
				"cluster",
				"labels",
			]);
			for (const [key] of actual.searchParams) {
				if (!expected.searchParams.has(key) && !defaultQueryParams.has(key)) return false;
			}
			return true;
		} catch {
			return actualPath === expectedPath;
		}
	}

	function navigateTo(nextPath: string) {
		currentPath = normalizePath(nextPath);
		nativeChrome = false;
		pendingNavigationPath = currentPath;
		replaceOuterUrl(currentPath);
	}

	function reloadFrame() {
		pendingNavigationPath = null;
		frameKey += 1;
	}

	function toggleNativeChrome() {
		pendingNavigationPath = null;
		nativeChrome = !nativeChrome;
	}

	function syncFromFrame() {
		try {
			const location = iframeEl?.contentWindow?.location;
			if (!location) return;
			const nextPath = normalizePath(`${location.pathname}${location.search}${location.hash}`);
			if (pendingNavigationPath) {
				if (pathMatchesPendingNavigation(nextPath, pendingNavigationPath)) {
					pendingNavigationPath = null;
				} else {
					applyUnifiedChrome();
					return;
				}
			}
			if (nextPath !== currentPath) {
				currentPath = nextPath;
				replaceOuterUrl(nextPath);
			}
			applyUnifiedChrome();
		} catch {
			/* The proxy is same-origin; ignore transient frame navigation races. */
		}
	}

	function applyUnifiedChrome() {
		try {
			const doc = iframeEl?.contentDocument;
			if (!doc) return;
			doc.documentElement.dataset.workflowBuilderChrome = nativeChrome ? "native" : "unified";
			const styleId = "workflow-builder-embedded-app-css";
			const existing = doc.getElementById(styleId);
			if (nativeChrome || !unifiedCss.trim()) {
				existing?.remove();
				return;
			}
			const style =
				existing instanceof HTMLStyleElement ? existing : doc.createElement("style");
			style.id = styleId;
			style.textContent = unifiedCss;
			if (!existing) doc.head.appendChild(style);
		} catch {
			/* Ignore document access while the frame is between navigations. */
		}
	}

	onMount(() => {
		const interval = window.setInterval(syncFromFrame, 750);
		return () => window.clearInterval(interval);
	});
</script>

<svelte:head>
	<title>{title} · Workflow Builder</title>
</svelte:head>

<div class="flex h-dvh min-h-0 flex-col bg-background md:flex-row">
	<aside
		class="flex h-14 shrink-0 items-center border-b bg-card/95 px-2 md:h-dvh md:w-14 md:flex-col md:border-b-0 md:border-r md:px-0 md:py-2"
		aria-label={`${title} navigation`}
	>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<a
						{...props}
						href={`/workspaces/${workspaceSlug}/workflows`}
						data-sveltekit-reload
						class="mr-1 flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:mr-0 md:mb-2"
						aria-label="Back to Workflow Builder"
					>
						<ArrowLeft class="size-4" />
					</a>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content side="right">Back to Workflow Builder</Tooltip.Content>
		</Tooltip.Root>

		<div class="hidden h-px w-8 bg-border md:block"></div>

		<nav class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:mt-2 md:flex-col md:overflow-x-visible md:overflow-y-auto">
			{#each navItems as item (item.id)}
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<button
								{...props}
								type="button"
								class="flex size-9 shrink-0 items-center justify-center rounded-md transition-colors {itemActive(
									item,
								)
									? 'bg-primary text-primary-foreground'
									: 'text-muted-foreground hover:bg-accent hover:text-foreground'}"
								aria-label={item.label}
								onclick={() => navigateTo(item.path)}
							>
								<item.icon class="size-4" />
							</button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content side="right">{item.label}</Tooltip.Content>
				</Tooltip.Root>
			{/each}
		</nav>
	</aside>

	<section class="flex min-h-0 min-w-0 flex-1 flex-col">
		<header class="flex h-12 shrink-0 items-center justify-between gap-2 border-b bg-background px-3">
			<div class="flex min-w-0 items-center gap-2">
				<AppIcon class="size-5 shrink-0" aria-label={appIconLabel} />
				<div class="hidden min-w-0 items-center gap-1 text-muted-foreground sm:flex">
					<span class="truncate font-mono text-[11px]">{currentPathLabel}</span>
				</div>
			</div>

			<div class="flex shrink-0 items-center gap-1.5">
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant={nativeChrome ? "default" : "outline"}
								size="icon-sm"
								aria-label={nativeChrome ? "Use unified navigation" : nativeChromeLabel}
								onclick={toggleNativeChrome}
							>
								{#if nativeChrome}
									<PanelLeft class="size-3.5" />
								{:else}
									<Fullscreen class="size-3.5" />
								{/if}
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>{nativeChrome ? "Use unified navigation" : nativeChromeLabel}</Tooltip.Content>
				</Tooltip.Root>

				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="outline"
								size="icon-sm"
								aria-label={reloadLabel}
								onclick={reloadFrame}
							>
								<RefreshCw class="size-3.5" />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Reload</Tooltip.Content>
				</Tooltip.Root>

				{#if externalHref}
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="outline"
									size="icon-sm"
									href={externalHref}
									target="_blank"
									rel="noreferrer"
									aria-label={externalLabel}
								>
									<ExternalLink class="size-3.5" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content>{externalLabel}</Tooltip.Content>
					</Tooltip.Root>
				{/if}
			</div>
		</header>

		<div class="min-h-0 flex-1 bg-background">
			{#key frameKey}
				<iframe
					bind:this={iframeEl}
					title={frameTitle}
					src={iframeSrc}
					class="h-full w-full border-0 bg-background"
					referrerpolicy="same-origin"
					loading="eager"
					allow="clipboard-read; clipboard-write; fullscreen"
					allowfullscreen
					onload={syncFromFrame}
				></iframe>
			{/key}
		</div>
	</section>
</div>

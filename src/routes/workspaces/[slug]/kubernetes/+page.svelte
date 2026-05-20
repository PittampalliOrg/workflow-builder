<script lang="ts">
	import { onMount } from "svelte";
	import {
		Activity,
		ArrowLeft,
		Box,
		Boxes,
		BriefcaseBusiness,
		Database,
		ExternalLink,
		Fullscreen,
		GitBranch,
		Layers,
		ListTree,
		Network,
		PanelLeft,
		RefreshCw,
		Rows3,
		Server,
		Workflow,
	} from "@lucide/svelte";

	import HeadlampLogo from "$lib/components/gitops/icons/HeadlampLogo.svelte";
	import { Button } from "$lib/components/ui/button";
	import * as Tooltip from "$lib/components/ui/tooltip";
	import {
		HEADLAMP_EMBED_CHROME_NATIVE,
		HEADLAMP_EMBED_CHROME_UNIFIED,
		headlampEmbedSrc,
		headlampExternalUrl,
		normalizeEmbeddedHeadlampPath,
		normalizeHeadlampCluster,
		stripHeadlampEmbedParams,
		withHeadlampEmbedChrome,
		type HeadlampCluster,
	} from "$lib/headlamp/links";
	import type { PageData } from "./$types";

	type NavItem = {
		id: string;
		label: string;
		icon: typeof HeadlampLogo;
		path: string;
		match: (path: string) => boolean;
	};

	let { data }: { data: PageData } = $props();

	function initialHeadlampPath() {
		return stripHeadlampEmbedParams(data.path);
	}

	let currentPath = $state(initialHeadlampPath());
	let frameKey = $state(0);
	let nativeChrome = $state(false);
	let iframeEl = $state<HTMLIFrameElement | null>(null);

	const activeCluster = $derived(getClusterFromPath(currentPath));
	const navItems = $derived(buildNavItems(activeCluster));
	const iframeSrc = $derived(
		withHeadlampEmbedChrome({
			src: headlampEmbedSrc({ embedBase: data.embedBase, path: currentPath }),
			chrome: nativeChrome ? HEADLAMP_EMBED_CHROME_NATIVE : HEADLAMP_EMBED_CHROME_UNIFIED,
		}),
	);
	const externalHref = $derived(
		headlampExternalUrl({ headlampBase: data.externalBase, path: currentPath }),
	);
	const pathLabel = $derived(formatPathLabel(currentPath));

	function clusterPath(cluster: HeadlampCluster) {
		return `/c/${encodeURIComponent(cluster)}/`;
	}

	function getClusterFromPath(path: string): HeadlampCluster {
		const [, prefix, cluster] = path.split("/");
		return prefix === "c" ? normalizeHeadlampCluster(cluster) : "ryzen";
	}

	function buildNavItems(cluster: HeadlampCluster): NavItem[] {
		const root = clusterPath(cluster);
		return [
			{
				id: "overview",
				label: "Overview",
				icon: Activity,
				path: root,
				match: (path) => path === root,
			},
			{
				id: "workloads",
				label: "Workloads",
				icon: Layers,
				path: `${root}workloads`,
				match: (path) => path.startsWith(`${root}workloads`),
			},
			{
				id: "pods",
				label: "Pods",
				icon: Box,
				path: `${root}pods`,
				match: (path) => path.startsWith(`${root}pods`),
			},
			{
				id: "deployments",
				label: "Deployments",
				icon: Boxes,
				path: `${root}deployments`,
				match: (path) => path.startsWith(`${root}deployments`),
			},
			{
				id: "jobs",
				label: "Jobs",
				icon: Workflow,
				path: `${root}jobs`,
				match: (path) => path.startsWith(`${root}jobs`),
			},
			{
				id: "network",
				label: "Services",
				icon: Network,
				path: `${root}services`,
				match: (path) =>
					path.startsWith(`${root}services`) || path.startsWith(`${root}ingresses`),
			},
			{
				id: "storage",
				label: "Storage",
				icon: Database,
				path: `${root}persistentvolumeclaims`,
				match: (path) =>
					path.startsWith(`${root}persistentvolumeclaims`) ||
					path.startsWith(`${root}persistentvolumes`) ||
					path.startsWith(`${root}storageclasses`),
			},
			{
				id: "namespaces",
				label: "Namespaces",
				icon: BriefcaseBusiness,
				path: `${root}namespaces`,
				match: (path) => path.startsWith(`${root}namespaces`),
			},
			{
				id: "events",
				label: "Events",
				icon: Rows3,
				path: `${root}events`,
				match: (path) => path.startsWith(`${root}events`),
			},
			{
				id: "customresources",
				label: "Custom resources",
				icon: ListTree,
				path: `${root}customresources`,
				match: (path) => path.startsWith(`${root}customresources`),
			},
			{
				id: "kueue",
				label: "Kueue workloads",
				icon: GitBranch,
				path: `${root}customresources/workloads.kueue.x-k8s.io`,
				match: (path) => path.includes("/customresources/") && path.includes(".kueue.x-k8s.io"),
			},
		];
	}

	function formatPathLabel(path: string): string {
		const normalized = stripHeadlampEmbedParams(path);
		if (normalized === "/") return "Cluster overview";
		try {
			return decodeURIComponent(normalized.replace(/^\/c\//, ""));
		} catch {
			return normalized;
		}
	}

	function replaceOuterUrl(path: string) {
		if (typeof window === "undefined") return;
		const next = new URL(window.location.href);
		next.searchParams.set("path", stripHeadlampEmbedParams(path));
		window.history.replaceState(window.history.state, "", `${next.pathname}?${next.searchParams}`);
	}

	function navigateTo(path: string) {
		currentPath = stripHeadlampEmbedParams(path);
		nativeChrome = false;
		replaceOuterUrl(currentPath);
		frameKey += 1;
	}

	function reloadFrame() {
		frameKey += 1;
	}

	function toggleNativeChrome() {
		nativeChrome = !nativeChrome;
		frameKey += 1;
	}

	function handleClusterChange(event: Event) {
		const select = event.currentTarget as HTMLSelectElement;
		navigateTo(clusterPath(normalizeHeadlampCluster(select.value)));
	}

	function syncFromFrame() {
		try {
			const location = iframeEl?.contentWindow?.location;
			if (!location) return;
			const nextPath = stripHeadlampEmbedParams(
				normalizeEmbeddedHeadlampPath(`${location.pathname}${location.search}`),
			);
			if (nextPath !== "/" && nextPath !== currentPath) {
				currentPath = nextPath;
				replaceOuterUrl(nextPath);
			}
		} catch {
			/* The proxy is same-origin; ignore transient frame navigation races. */
		}
	}

	onMount(() => {
		const interval = window.setInterval(syncFromFrame, 750);
		return () => window.clearInterval(interval);
	});
</script>

<svelte:head>
	<title>Kubernetes · Workflow Builder</title>
</svelte:head>

<div class="flex h-dvh min-h-0 flex-col bg-background md:flex-row">
	<aside
		class="flex h-14 shrink-0 items-center border-b bg-card/95 px-2 md:h-dvh md:w-14 md:flex-col md:border-b-0 md:border-r md:px-0 md:py-2"
		aria-label="Kubernetes navigation"
	>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<a
						{...props}
						href={`/workspaces/${data.slug}/workflows`}
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
								class="flex size-9 shrink-0 items-center justify-center rounded-md transition-colors {item.match(
									currentPath,
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
				<HeadlampLogo class="size-5 shrink-0" />
				<select
					class="h-8 w-[8.5rem] shrink-0"
					aria-label="Cluster"
					value={activeCluster}
					onchange={handleClusterChange}
				>
					{#each data.clusters as cluster}
						<option value={cluster}>{cluster}</option>
					{/each}
				</select>
				<div class="hidden min-w-0 items-center gap-1 text-muted-foreground sm:flex">
					<Server class="size-3.5 shrink-0" />
					<span class="truncate font-mono text-[11px]">{pathLabel}</span>
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
								aria-label="Toggle native Headlamp chrome"
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
					<Tooltip.Content>{nativeChrome ? "Use unified navigation" : "Show native Headlamp chrome"}</Tooltip.Content>
				</Tooltip.Root>

				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="outline"
								size="icon-sm"
								aria-label="Reload Kubernetes view"
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
									aria-label="Open in Headlamp"
								>
									<ExternalLink class="size-3.5" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content>Open in Headlamp</Tooltip.Content>
					</Tooltip.Root>
				{/if}
			</div>
		</header>

		<div class="min-h-0 flex-1 bg-background">
			{#key `${frameKey}:${nativeChrome}`}
				<iframe
					bind:this={iframeEl}
					title="Kubernetes"
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

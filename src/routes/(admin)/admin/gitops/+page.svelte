<script lang="ts">
	import { onDestroy, onMount, untrack } from "svelte";
	import {
		AlertTriangle,
		GitBranch,
		Inbox as InboxIcon,
		History,
		Layers,
		RefreshCw,
		Workflow,
	} from "@lucide/svelte";

	import { browser } from "$app/environment";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";

	import InboxView from "$lib/components/promoter/InboxView.svelte";
	import PipelineView from "$lib/components/promoter/PipelineView.svelte";
	import TimelineView from "$lib/components/promoter/TimelineView.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { buildInboxRows } from "$lib/promoter/inbox-view";
	import {
		buildServiceMatrix,
		summarizeMatrix,
	} from "$lib/gitops/service-matrix";
	import type { DeploymentMetadataResponse } from "$lib/types/deployment-metadata";
	import { relativeTime } from "$lib/utils/gitops-display";

	import type { PageData } from "./$types";
	import ServicesTab from "./ServicesTab.svelte";
	import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";

	type Props = { data: PageData };
	let { data }: Props = $props();

	type TabId = "pipelines" | "inbox" | "timeline" | "services";
	const TAB_IDS: TabId[] = ["pipelines", "inbox", "timeline", "services"];
	function isTab(s: string | null | undefined): s is TabId {
		return !!s && (TAB_IDS as readonly string[]).includes(s);
	}

	const initialTab: TabId = (() => {
		const fromUrl = page.url.searchParams.get("tab");
		return isTab(fromUrl) ? fromUrl : "pipelines";
	})();

	let metadata = $state<DeploymentMetadataResponse>(untrack(() => data.initial));
	let promotions = $state<PromotionStrategiesResponse>(untrack(() => data.promotions));
	let tektonBase = $state<string | null>(untrack(() => data.tektonBase));
	const links = untrack(() => data.links);
	let loading = $state(false);
	let errorMessage = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;
	let clockTimer: ReturnType<typeof setInterval> | null = null;
	let now = $state<number>(Date.now());

	let tab = $state<TabId>(initialTab);

	// Sync tab ← URL for browser back/forward. The read/write of `tab` is
	// untracked so this effect doesn't subscribe to its own write.
	$effect(() => {
		const fromUrl = page.url.searchParams.get("tab");
		const next: TabId = isTab(fromUrl) ? fromUrl : "pipelines";
		untrack(() => {
			if (next !== tab) tab = next;
		});
	});

	// Direct click handler for the tab buttons. Owns both `tab` and the URL.
	function setTab(next: TabId) {
		if (tab !== next) tab = next;
		if (typeof window === "undefined") return;
		const current = new URL(window.location.href);
		if (current.searchParams.get("tab") === next) return;
		current.searchParams.set("tab", next);
		void goto(current.pathname + current.search, {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	async function refresh() {
		loading = true;
		try {
			const [metaRes, promoRes] = await Promise.all([
				fetch("/api/v1/gitops/deployment-metadata"),
				fetch("/api/v1/gitops/promotions"),
			]);
			if (!metaRes.ok) throw new Error(`metadata: ${metaRes.status} ${metaRes.statusText}`);
			if (!promoRes.ok) throw new Error(`promotions: ${promoRes.status} ${promoRes.statusText}`);
			metadata = (await metaRes.json()) as DeploymentMetadataResponse;
			promotions = (await promoRes.json()) as PromotionStrategiesResponse;
			const errors = [
				metadata.live.error,
				metadata.gitops.releasePinsError,
				metadata.inventory.error,
				promotions.error,
			].filter((message): message is string => Boolean(message));
			errorMessage = errors.length ? errors.join(" / ") : null;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		timer = setInterval(() => void refresh(), 15_000);
		clockTimer = setInterval(() => (now = Date.now()), 30_000);
	});
	onDestroy(() => {
		if (timer) clearInterval(timer);
		if (clockTimer) clearInterval(clockTimer);
	});

	const envLabel = $derived(metadata.environment.name ?? "unknown");
	const stacksShortSha = $derived(metadata.gitops.stacksMain?.shortSha ?? "—");
	const stacksUrl = $derived(metadata.gitops.stacksMain?.url ?? null);

	// Combine matrix + promotion attention into one summary chip.
	const matrixSummary = $derived.by(() =>
		summarizeMatrix(
			buildServiceMatrix({
				inventory: metadata.inventory.data,
				releasePins: metadata.gitops.desiredImages,
				live: metadata.live.deployments,
				currentEnv: metadata.environment.name,
			}),
		),
	);
	const inboxRows = $derived(buildInboxRows(promotions.strategies));
	const promoterIssues = $derived.by(() => {
		let pending = 0;
		let failed = 0;
		for (const row of inboxRows) {
			if (row.phase === "failure") failed += 1;
			else if (row.phase === "pending") pending += 1;
		}
		return { pending, failed };
	});

	const attention = $derived.by(() => {
		if (metadata.inventory.error)
			return { tone: "error" as const, text: `Inventory error: ${metadata.inventory.error}` };
		if (
			matrixSummary.degradedApps > 0 ||
			matrixSummary.failedBuilds > 0 ||
			promoterIssues.failed > 0
		) {
			const parts: string[] = [];
			if (matrixSummary.failedBuilds > 0)
				parts.push(`${matrixSummary.failedBuilds} failed build${matrixSummary.failedBuilds === 1 ? "" : "s"}`);
			if (matrixSummary.degradedApps > 0) parts.push(`${matrixSummary.degradedApps} degraded`);
			if (promoterIssues.failed > 0)
				parts.push(`${promoterIssues.failed} promotion${promoterIssues.failed === 1 ? "" : "s"} failed`);
			return { tone: "error" as const, text: parts.join(" · ") };
		}
		if (matrixSummary.driftCount > 0 || promoterIssues.pending > 0) {
			const parts: string[] = [];
			if (matrixSummary.driftCount > 0)
				parts.push(`${matrixSummary.driftCount} drift`);
			if (promoterIssues.pending > 0)
				parts.push(
					`${promoterIssues.pending} promotion${promoterIssues.pending === 1 ? "" : "s"} pending`,
				);
			return { tone: "warn" as const, text: parts.join(" · ") };
		}
		return null;
	});

	function handleGlobalKey(event: KeyboardEvent) {
		// Press `1`–`4` to jump between tabs (without modifiers, outside inputs).
		const target = event.target as HTMLElement | null;
		const isEditable =
			target &&
			(target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable);
		if (isEditable) return;
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
		switch (event.key) {
			case "1":
				event.preventDefault();
				setTab("pipelines");
				break;
			case "2":
				event.preventDefault();
				setTab("inbox");
				break;
			case "3":
				event.preventDefault();
				setTab("timeline");
				break;
			case "4":
				event.preventDefault();
				setTab("services");
				break;
		}
	}

	$effect(() => {
		if (!browser) return;
		window.addEventListener("keydown", handleGlobalKey);
		return () => window.removeEventListener("keydown", handleGlobalKey);
	});
</script>

<svelte:head>
	<title>GitOps · Workflow Builder</title>
</svelte:head>

<div class="flex h-full flex-col overflow-hidden">
	<header class="border-b px-5 py-3">
		<div class="flex items-center justify-between gap-3">
			<div class="flex items-center gap-2">
				<GitBranch class="size-5 text-muted-foreground" />
				<h1 class="text-lg font-semibold">GitOps</h1>
				<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">{envLabel}</Badge>
				{#if attention}
					<Badge
						variant={attention.tone === "error" ? "destructive" : "outline"}
						class="h-5 gap-1 px-1.5 text-[0.65rem] {attention.tone === 'warn'
							? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200'
							: ''}"
					>
						<AlertTriangle class="size-3" />
						{attention.text}
					</Badge>
				{/if}
				{#if promotions.source === "fixture"}
					<Badge variant="outline" class="h-5 px-1.5 text-[0.6rem] uppercase tracking-wide">
						fixture data
					</Badge>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				{#if stacksUrl}
					<a
						class="flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
						href={stacksUrl}
						target="_blank"
						rel="noreferrer"
					>
						<GitBranch class="size-3" />
						stacks/main <span class="font-mono">{stacksShortSha}</span>
					</a>
				{/if}
				<span class="text-[0.7rem] text-muted-foreground">
					Updated {relativeTime(metadata.generatedAt)}
				</span>
				<Button variant="outline" size="sm" onclick={refresh} disabled={loading} class="h-7">
					{#if loading}
						<RefreshCw class="size-3.5 animate-spin" />
					{:else}
						<RefreshCw class="size-3.5" />
					{/if}
					Refresh
				</Button>
			</div>
		</div>
	</header>

	{#if errorMessage}
		<div class="border-b bg-destructive/5 px-5 py-2 text-xs text-destructive">
			{errorMessage}
		</div>
	{/if}

	<div class="border-b px-5 py-2">
		<div role="tablist" class="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-[3px] text-muted-foreground">
			<button
				type="button"
				role="tab"
				aria-selected={tab === "pipelines"}
				onclick={() => setTab("pipelines")}
				class="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors {tab === 'pipelines' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'}"
			>
				<Workflow class="size-3.5" />
				Pipelines
				{#if promoterIssues.failed > 0}
					<Badge variant="destructive" class="ml-1 h-4 px-1 text-[0.6rem]">
						{promoterIssues.failed}
					</Badge>
				{:else if promoterIssues.pending > 0}
					<Badge variant="outline" class="ml-1 h-4 border-amber-300 bg-amber-50 px-1 text-[0.6rem] text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
						{promoterIssues.pending}
					</Badge>
				{/if}
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={tab === "inbox"}
				onclick={() => setTab("inbox")}
				class="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors {tab === 'inbox' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'}"
			>
				<InboxIcon class="size-3.5" />
				Inbox
				{#if promotions.strategies.length > 0}
					<span class="ml-1 text-[0.65rem] text-muted-foreground">
						{promotions.strategies.length}
					</span>
				{/if}
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={tab === "timeline"}
				onclick={() => setTab("timeline")}
				class="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors {tab === 'timeline' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'}"
			>
				<History class="size-3.5" />
				Timeline
			</button>
			<button
				type="button"
				role="tab"
				aria-selected={tab === "services"}
				onclick={() => setTab("services")}
				class="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors {tab === 'services' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'}"
			>
				<Layers class="size-3.5" />
				Services
			</button>
		</div>
	</div>

	{#if tab === "pipelines"}
		<div class="flex flex-1 min-h-0 flex-col overflow-hidden">
			<PipelineView
				{promotions}
				{links}
				{tektonBase}
				selectedStrategy={page.url.searchParams.get("strategy")}
				onSelectStrategy={(name) => {
					const url = new URL(page.url);
					if (name) url.searchParams.set("strategy", name);
					else url.searchParams.delete("strategy");
					goto(url.pathname + url.search, { replaceState: true, noScroll: true, keepFocus: true });
				}}
			/>
		</div>
	{:else if tab === "inbox"}
		<div class="flex flex-1 min-h-0 flex-col overflow-hidden">
			<InboxView
				{promotions}
				{links}
				onOpenStrategy={(name) => {
					const url = new URL(page.url);
					url.searchParams.set("strategy", name);
					goto(url.pathname + url.search, { replaceState: true, noScroll: true, keepFocus: true });
					setTab("pipelines");
				}}
			/>
		</div>
	{:else if tab === "timeline"}
		<div class="flex flex-1 min-h-0 flex-col overflow-hidden">
			<TimelineView
				{promotions}
				{links}
				selectedStrategy={page.url.searchParams.get("strategy")}
				onSelectStrategy={(name) => {
					const url = new URL(page.url);
					if (name) url.searchParams.set("strategy", name);
					else url.searchParams.delete("strategy");
					goto(url.pathname + url.search, { replaceState: true, noScroll: true, keepFocus: true });
				}}
			/>
		</div>
	{:else if tab === "services"}
		<div class="flex flex-1 min-h-0 flex-col overflow-hidden">
			<ServicesTab {metadata} {tektonBase} {links} {now} />
		</div>
	{/if}
</div>

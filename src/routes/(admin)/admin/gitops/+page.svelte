<script lang="ts">
	import { onDestroy, onMount, untrack } from "svelte";
	import {
		AlertTriangle,
		Container,
		GitBranch,
		Inbox as InboxIcon,
		History,
		Layers,
		LayoutDashboard,
		RefreshCw,
		Workflow,
	} from "@lucide/svelte";

	import { browser } from "$app/environment";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";

	import OverviewTab from "$lib/components/gitops/OverviewTab.svelte";
	import type { OverviewTabData } from "$lib/components/gitops/OverviewTab.svelte";
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
	import {
		GITOPS_EVENT_REFRESH_DEBOUNCE_MS,
		gitOpsDeploymentMetadataUrl,
		shouldRefreshGitOpsMetadata,
	} from "$lib/gitops/event-driven-refresh";
	import type {
		DeploymentMetadataResponse,
		FleetDriftExtras,
	} from "$lib/types/deployment-metadata";
	import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";
	import { relativeTime } from "$lib/utils/gitops-display";

	import type { PageData } from "./$types";
	import { getFleetDriftExtras } from "./data.remote";
	import PreviewPlatformPanel from "./PreviewPlatformPanel.svelte";
	import PromotionPulse from "./PromotionPulse.svelte";
	import ServicesTab from "./ServicesTab.svelte";
	import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";

	type Props = { data: PageData };
	let { data }: Props = $props();

	type TabId = "overview" | "promotions" | "inbox" | "timeline" | "services";
	const TAB_IDS: TabId[] = ["overview", "promotions", "inbox", "timeline", "services"];
	/** Normalize a `?tab=` value; the legacy `pipelines` label maps to `promotions`. */
	function normalizeTab(s: string | null | undefined): TabId {
		if (s === "pipelines") return "promotions";
		return !!s && (TAB_IDS as readonly string[]).includes(s) ? (s as TabId) : "overview";
	}

	const initialTab: TabId = normalizeTab(page.url.searchParams.get("tab"));

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

	// Fleet-drift extras (repo HEADs, pin ages, newest builds, preview-platform
	// broker skew). Remote query: 15s server-side cache, degrades to nulls.
	const fleetExtrasQuery = getFleetDriftExtras();
	const fleetExtras = $derived<FleetDriftExtras | null>(fleetExtrasQuery.current ?? null);
	const fleetExtrasLoading = $derived(fleetExtrasQuery.current === undefined);
	const previewSkew = $derived(fleetExtras?.previewPlatform.skew === true);

	// The consolidated overview tab owns the single live activity EventSource (it
	// needs the events for the pipeline overlay); the promoter tabs stay fresh via
	// the fetch fallback poll below. When the overview tab is NOT mounted, this
	// page runs its own invalidation-only stream (see the effect below) — the two
	// never coexist, so the surface still holds one EventSource at a time.
	const overviewData = $derived<OverviewTabData>({
		initial: metadata,
		promotions,
		activityEvents: data.activityEvents ?? [],
		prPreviews: data.prPreviews ?? [],
		links: data.overviewLinks,
		viewerEmail: data.viewerEmail,
	});

	// Sync tab ← URL for browser back/forward. The read/write of `tab` is
	// untracked so this effect doesn't subscribe to its own write.
	$effect(() => {
		const next = normalizeTab(page.url.searchParams.get("tab"));
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

	function tabButtonId(id: TabId): string {
		return `gitops-tab-${id}`;
	}

	function tabPanelId(id: TabId): string {
		return `gitops-panel-${id}`;
	}

	function handleTabListKey(event: KeyboardEvent) {
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;

		const target = event.target as HTMLElement | null;
		const currentId = target?.closest<HTMLButtonElement>("[role='tab']")?.dataset.tab as
			| TabId
			| undefined;
		const currentIndex = currentId ? TAB_IDS.indexOf(currentId) : TAB_IDS.indexOf(tab);
		let nextIndex = currentIndex;

		if (event.key === "Home") nextIndex = 0;
		else if (event.key === "End") nextIndex = TAB_IDS.length - 1;
		else if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % TAB_IDS.length;
		else nextIndex = (currentIndex - 1 + TAB_IDS.length) % TAB_IDS.length;

		event.preventDefault();
		const next = TAB_IDS[nextIndex]!;
		setTab(next);
		(event.currentTarget as HTMLElement)
			.querySelector<HTMLButtonElement>(`#${tabButtonId(next)}`)
			?.focus();
	}

	async function refresh(options: { fresh?: boolean } = {}) {
		loading = true;
		// Refresh the fleet-drift extras alongside (never blocks the page refresh;
		// the server read degrades to stale-on-error and does not throw).
		void fleetExtrasQuery.refresh().catch(() => undefined);
		try {
			const [metaRes, promoRes] = await Promise.all([
				fetch(gitOpsDeploymentMetadataUrl(options)),
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
		// 15s fetch fallback keeps the promoter tabs fresh. The live event stream
		// belongs to the overview tab (single EventSource across the surface).
		startFallbackPolling();
		clockTimer = setInterval(() => (now = Date.now()), 30_000);
	});
	onDestroy(() => {
		stopFallbackPolling();
		if (clockTimer) clearInterval(clockTimer);
	});

	function startFallbackPolling() {
		if (!timer) timer = setInterval(() => void refresh(), 15_000);
	}

	function stopFallbackPolling() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	// Cache-invalidation refresh from the existing GitOps SSE stream. Only runs
	// while the overview tab is NOT mounted (OverviewTab owns the stream there),
	// so the page never holds two streams. Relevant events (Tekton, promoter,
	// ArgoCD, inventory ConfigMap) debounce into one metadata + extras refresh.
	$effect(() => {
		if (!browser) return;
		if (tab === "overview") return;
		const es = new EventSource("/api/v1/gitops/events/stream");
		let debounceTimer: ReturnType<typeof setTimeout> | null = null;
		es.addEventListener("gitops.event", (event) => {
			try {
				const parsed = JSON.parse(
					(event as MessageEvent<string>).data,
				) as GitOpsActivityEvent;
				if (!shouldRefreshGitOpsMetadata(parsed)) return;
				if (debounceTimer) clearTimeout(debounceTimer);
				debounceTimer = setTimeout(() => {
					debounceTimer = null;
					void refresh();
				}, GITOPS_EVENT_REFRESH_DEBOUNCE_MS);
			} catch {
				// Malformed event payloads are ignored; polling still covers us.
			}
		});
		return () => {
			es.close();
			if (debounceTimer) clearTimeout(debounceTimer);
		};
	});

	function openStrategy(name: string) {
		const url = new URL(page.url);
		url.searchParams.set("strategy", name);
		url.searchParams.set("tab", "promotions");
		void goto(url.pathname + url.search, {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
		setTab("promotions");
	}

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
		// Press `1`–`5` to jump between tabs (without modifiers, outside inputs).
		const target = event.target as HTMLElement | null;
		const isEditable =
			target &&
			(target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable);
		if (isEditable) return;
		if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
		const index = Number.parseInt(event.key, 10);
		if (Number.isInteger(index) && index >= 1 && index <= TAB_IDS.length) {
			event.preventDefault();
			setTab(TAB_IDS[index - 1]!);
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
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex min-w-0 flex-wrap items-center gap-2">
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
				{#if previewSkew}
					<button
						type="button"
						onclick={() => setTab("overview")}
						title="Preview-control broker digest differs from release-pins — open the overview for detail"
					>
						<Badge
							variant="outline"
							class="h-5 gap-1 border-amber-300 bg-amber-50 px-1.5 text-[0.65rem] text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200"
						>
							<AlertTriangle class="size-3" />
							Preview platform skew
						</Badge>
					</button>
				{/if}
				{#if promotions.source === "fixture"}
					<Badge variant="outline" class="h-5 px-1.5 text-[0.6rem] uppercase tracking-wide">
						fixture data
					</Badge>
				{/if}
			</div>
			<div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
				<Button
					variant="ghost"
					size="sm"
					href="/workspaces/default/dev"
					class="h-7 gap-1.5 px-2 text-xs"
					aria-label="Dev environments"
				>
					<Container class="size-3.5" />
					<span class="hidden sm:inline">Dev environments</span>
				</Button>
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
				<Button
					variant="outline"
					size="sm"
					onclick={() => void refresh({ fresh: true })}
					disabled={loading}
					class="h-7"
				>
					{#if loading}
						<RefreshCw class="size-3.5 motion-safe:animate-spin" />
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

	<div class="overflow-x-auto border-b px-5 py-2">
		<div
			role="tablist"
			aria-label="GitOps views"
			tabindex="-1"
			onkeydown={handleTabListKey}
			class="inline-flex min-w-max items-center gap-1 rounded-lg bg-muted p-[3px] text-muted-foreground"
		>
			<button
				id={tabButtonId("overview")}
				data-tab="overview"
				type="button"
				role="tab"
				aria-selected={tab === "overview"}
				aria-controls={tabPanelId("overview")}
				tabindex={tab === "overview" ? 0 : -1}
				onclick={() => setTab("overview")}
				class="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors {tab === 'overview' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'}"
			>
				<LayoutDashboard class="size-3.5" />
				Overview
			</button>
			<button
				id={tabButtonId("promotions")}
				data-tab="promotions"
				type="button"
				role="tab"
				aria-selected={tab === "promotions"}
				aria-controls={tabPanelId("promotions")}
				tabindex={tab === "promotions" ? 0 : -1}
				onclick={() => setTab("promotions")}
				class="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors {tab === 'promotions' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'}"
			>
				<Workflow class="size-3.5" />
				Promotions
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
				id={tabButtonId("inbox")}
				data-tab="inbox"
				type="button"
				role="tab"
				aria-selected={tab === "inbox"}
				aria-controls={tabPanelId("inbox")}
				tabindex={tab === "inbox" ? 0 : -1}
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
				id={tabButtonId("timeline")}
				data-tab="timeline"
				type="button"
				role="tab"
				aria-selected={tab === "timeline"}
				aria-controls={tabPanelId("timeline")}
				tabindex={tab === "timeline" ? 0 : -1}
				onclick={() => setTab("timeline")}
				class="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors {tab === 'timeline' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'}"
			>
				<History class="size-3.5" />
				Timeline
			</button>
			<button
				id={tabButtonId("services")}
				data-tab="services"
				type="button"
				role="tab"
				aria-selected={tab === "services"}
				aria-controls={tabPanelId("services")}
				tabindex={tab === "services" ? 0 : -1}
				onclick={() => setTab("services")}
				class="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors {tab === 'services' ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground'}"
			>
				<Layers class="size-3.5" />
				Services
			</button>
		</div>
	</div>

	<div
		id={tabPanelId("overview")}
		role="tabpanel"
		aria-labelledby={tabButtonId("overview")}
		tabindex="0"
		hidden={tab !== "overview"}
		class={tab === "overview" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}
	>
		{#if tab === "overview"}
			<!-- Platform pulse strip: preview-platform broker skew + compact
			     promotion/env-branch state from the hub inventory. -->
			<div class="flex flex-col gap-2 border-b bg-background px-5 py-2.5">
				<PreviewPlatformPanel
					extras={fleetExtras}
					loading={fleetExtrasLoading}
					{links}
				/>
				<PromotionPulse {promotions} {links} onOpenStrategy={openStrategy} />
			</div>
			<OverviewTab data={overviewData} />
		{/if}
	</div>
	<div
		id={tabPanelId("promotions")}
		role="tabpanel"
		aria-labelledby={tabButtonId("promotions")}
		tabindex="0"
		hidden={tab !== "promotions"}
		class={tab === "promotions" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}
	>
		{#if tab === "promotions"}
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
		{/if}
	</div>
	<div
		id={tabPanelId("inbox")}
		role="tabpanel"
		aria-labelledby={tabButtonId("inbox")}
		tabindex="0"
		hidden={tab !== "inbox"}
		class={tab === "inbox" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}
	>
		{#if tab === "inbox"}
			<InboxView
				{promotions}
				{links}
				onOpenStrategy={(name) => {
					const url = new URL(page.url);
					url.searchParams.set("strategy", name);
					goto(url.pathname + url.search, { replaceState: true, noScroll: true, keepFocus: true });
					setTab("promotions");
				}}
				/>
		{/if}
	</div>
	<div
		id={tabPanelId("timeline")}
		role="tabpanel"
		aria-labelledby={tabButtonId("timeline")}
		tabindex="0"
		hidden={tab !== "timeline"}
		class={tab === "timeline" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}
	>
		{#if tab === "timeline"}
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
		{/if}
	</div>
	<div
		id={tabPanelId("services")}
		role="tabpanel"
		aria-labelledby={tabButtonId("services")}
		tabindex="0"
		hidden={tab !== "services"}
		class={tab === "services" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}
	>
		{#if tab === "services"}
			<ServicesTab
				{metadata}
				{tektonBase}
				{links}
				{now}
				extras={fleetExtras}
				extrasLoading={fleetExtrasLoading}
			/>
		{/if}
	</div>
</div>

<script lang="ts">
	import { untrack } from "svelte";
	import {
		Activity,
		Database,
		Radar,
		Siren,
		Waypoints,
	} from "@lucide/svelte";

	import { browser } from "$app/environment";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";

	import DetailSheet from "$lib/components/drasi/DetailSheet.svelte";
	import DataSourcesTab from "$lib/components/drasi/DataSourcesTab.svelte";
	import IncidentsTab from "$lib/components/drasi/IncidentsTab.svelte";
	import QueriesTab from "$lib/components/drasi/QueriesTab.svelte";
	import TopologyCanvas from "$lib/components/drasi/TopologyCanvas.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import * as Tooltip from "$lib/components/ui/tooltip";
	import { DRASI_COUNTS } from "$lib/drasi/catalog";
	import type { DrasiSelection } from "$lib/types/drasi";

	type TabId = "system" | "queries" | "data-sources" | "incidents";
	const TAB_IDS: TabId[] = ["system", "queries", "data-sources", "incidents"];

	/** Normalize a `?tab=` value so unknown or missing params land on `system`. */
	function normalizeTab(value: string | null | undefined): TabId {
		// Legacy/alternate spellings collapse onto canonical ids.
		if (value === "sources") return "data-sources";
		return !!value && (TAB_IDS as readonly string[]).includes(value)
			? (value as TabId)
			: "system";
	}

	const initialTab: TabId = normalizeTab(page.url.searchParams.get("tab"));
	let tab = $state<TabId>(initialTab);

	let selection = $state<DrasiSelection | null>(null);
	let sheetOpen = $state(false);

	function handleSelect(next: DrasiSelection | null) {
		selection = next;
		sheetOpen = next !== null;
	}

	function inspectNode(nodeId: string) {
		selection = { kind: "node", id: nodeId };
		sheetOpen = true;
	}

	// Sync tab ← URL for browser back/forward. The read/write of `tab` is
	// untracked so this effect doesn't subscribe to its own write.
	$effect(() => {
		const next = normalizeTab(page.url.searchParams.get("tab"));
		untrack(() => {
			if (next !== tab) tab = next;
		});
	});

	function setTab(next: TabId) {
		if (tab !== next) tab = next;
		if (typeof window === "undefined") return;
		const current = new URL(window.location.href);
		if (current.searchParams.get("tab") === next) return;
		current.searchParams.set("tab", next);
		// Push (not replace) so in-app tab activation participates in browser
		// history: Back/Forward traverses `?tab=` states instead of leaving the
		// page. Canonical deep links and reload persistence still read `?tab=`.
		void goto(current.pathname + current.search, {
			noScroll: true,
			keepFocus: true,
		});
	}

	function tabButtonId(id: TabId): string {
		return `drasi-tab-${id}`;
	}

	function tabPanelId(id: TabId): string {
		return `drasi-panel-${id}`;
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

	function handleGlobalKey(event: KeyboardEvent) {
		// Press `1`–`4` to jump between tabs (without modifiers, outside inputs).
		// The shortcut is inert while the detail sheet is open: focus lives
		// inside the dialog and digits must not retarget the underlying tabs.
		if (sheetOpen) return;
		const target = event.target as HTMLElement | null;
		const isEditable =
			target &&
			(target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.tagName === "SELECT" ||
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
	<title>Drasi · Workflow Builder</title>
</svelte:head>

<div class="@container flex h-full min-w-0 flex-col overflow-hidden">
	<header class="border-b px-5 py-3 @max-md:px-3">
		<div class="flex flex-wrap items-center justify-between gap-3 @max-md:gap-1.5">
			<div class="flex min-w-0 flex-wrap items-center gap-2">
				<Radar class="size-5 shrink-0 text-muted-foreground" />
				<h1 class="text-lg font-semibold">Drasi</h1>
				<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">change detection</Badge>
			</div>
			<div
				class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 @max-md:ml-0 @max-md:w-full @max-md:justify-start"
			>
				<span class="text-[0.7rem] text-muted-foreground">
					Read-only · configured topology plus live state when a runtime answers
				</span>
			</div>
		</div>
	</header>

	<Tooltip.Provider>
		<div
			class="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-5 py-2 @max-md:flex-col @max-md:items-stretch @max-md:px-3"
		>
			<span
				class="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground/70"
			>
				Status
			</span>
			<Tooltip.Root>
				<Tooltip.Trigger
					class="inline-flex h-5 cursor-help items-center gap-1.5 rounded-md border px-1.5 text-[0.65rem] font-medium text-muted-foreground @max-md:h-auto @max-md:min-h-6 @max-md:w-full @max-md:justify-start @max-md:py-1 @max-md:text-left @max-md:leading-snug"
				>
					<span
						class="size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
						aria-hidden="true"
					></span>
					Runtime · Unavailable
				</Tooltip.Trigger>
				<Tooltip.Content>
					No Drasi runtime is connected to this preview environment. Live readiness,
					counters, and lag are reported as Unavailable rather than estimated.
				</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger
					class="inline-flex h-5 cursor-help items-center gap-1.5 rounded-md border px-1.5 text-[0.65rem] font-medium"
				>
					<span class="size-1.5 rounded-full bg-emerald-500" aria-hidden="true"></span>
					{DRASI_COUNTS.sources} sources configured
				</Tooltip.Trigger>
				<Tooltip.Content>
					workflow-builder-postgres · workflow-builder-k8s-observations-v2
				</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger
					class="inline-flex h-5 cursor-help items-center gap-1.5 rounded-md border px-1.5 text-[0.65rem] font-medium @max-md:h-auto @max-md:min-h-6 @max-md:w-full @max-md:justify-start @max-md:py-1 @max-md:text-left @max-md:leading-snug"
				>
					<span class="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true"></span>
					{DRASI_COUNTS.queries} continuous queries configured
				</Tooltip.Trigger>
				<Tooltip.Content>
					Stall, failure-storm, provisioning, admission, and Dapr warning/drift
					detectors. See the Queries tab.
				</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger
					class="inline-flex h-5 cursor-help items-center gap-1.5 rounded-md border px-1.5 text-[0.65rem] font-medium @max-md:h-auto @max-md:min-h-6 @max-md:w-full @max-md:justify-start @max-md:py-1 @max-md:text-left @max-md:leading-snug"
				>
					<span class="size-1.5 shrink-0 rounded-full bg-emerald-500" aria-hidden="true"></span>
					{DRASI_COUNTS.reactions} reaction configured
				</Tooltip.Trigger>
				<Tooltip.Content>
					workflow-builder-incident-agent-v2 posts added results to Workflow Builder's
					governed ingest endpoint.
				</Tooltip.Content>
			</Tooltip.Root>
			<Tooltip.Root>
				<Tooltip.Trigger
					class="inline-flex h-5 cursor-help items-center gap-1.5 rounded-md border px-1.5 text-[0.65rem] font-medium text-muted-foreground @max-md:h-auto @max-md:min-h-6 @max-md:w-full @max-md:justify-start @max-md:py-1 @max-md:text-left @max-md:leading-snug"
				>
					<span
						class="size-1.5 shrink-0 rounded-full bg-muted-foreground/60"
						aria-hidden="true"
					></span>
					Last observation · Unavailable
				</Tooltip.Trigger>
				<Tooltip.Content>
					A transition timestamp is not a heartbeat. Observation freshness requires a
					connected runtime.
				</Tooltip.Content>
			</Tooltip.Root>
		</div>
	</Tooltip.Provider>

	<div class="overflow-x-auto border-b px-5 py-2 @max-md:px-3">
		<div
			role="tablist"
			aria-label="Drasi views"
			tabindex="-1"
			onkeydown={handleTabListKey}
			class="inline-flex min-w-max items-center gap-1 rounded-lg bg-muted p-[3px] text-muted-foreground @max-md:grid @max-md:w-full @max-md:min-w-0 @max-md:max-w-full @max-md:grid-cols-2 @max-md:items-stretch @max-md:gap-0.5"
		>
			<!-- Extreme narrow containers (a 390px viewport with the expanded
				sidebar leaves ~166px): decorative icons/counts drop, padding and
				font size shrink, and "Data sources" shortens to "Sources" so every
				tab keeps scrollWidth <= clientWidth without overlapping targets. -->
			<button
				id={tabButtonId("system")}
				data-tab="system"
				type="button"
				role="tab"
				aria-selected={tab === "system"}
				aria-controls={tabPanelId("system")}
				tabindex={tab === "system" ? 0 : -1}
				onclick={() => setTab("system")}
				class="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors @max-md:h-auto @max-md:min-h-8 @max-md:w-full @max-md:justify-center @max-md:gap-1 @max-md:px-1 @max-md:py-1 @max-md:text-[0.7rem] @max-md:leading-tight {tab ===
				'system'
					? 'bg-background text-foreground shadow-sm'
					: 'hover:text-foreground'}"
			>
				<Waypoints class="size-3.5 shrink-0 @max-md:hidden" />
				System
			</button>
			<button
				id={tabButtonId("queries")}
				data-tab="queries"
				type="button"
				role="tab"
				aria-selected={tab === "queries"}
				aria-controls={tabPanelId("queries")}
				tabindex={tab === "queries" ? 0 : -1}
				onclick={() => setTab("queries")}
				class="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors @max-md:h-auto @max-md:min-h-8 @max-md:w-full @max-md:justify-center @max-md:gap-1 @max-md:px-1 @max-md:py-1 @max-md:text-[0.7rem] @max-md:leading-tight {tab ===
				'queries'
					? 'bg-background text-foreground shadow-sm'
					: 'hover:text-foreground'}"
			>
				<Activity class="size-3.5 shrink-0 @max-md:hidden" />
				Queries
				<span class="ml-1 text-[0.65rem] text-muted-foreground @max-md:hidden">
					{DRASI_COUNTS.queries}
				</span>
			</button>
			<button
				id={tabButtonId("data-sources")}
				data-tab="data-sources"
				type="button"
				role="tab"
				aria-selected={tab === "data-sources"}
				aria-controls={tabPanelId("data-sources")}
				tabindex={tab === "data-sources" ? 0 : -1}
				onclick={() => setTab("data-sources")}
				class="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors @max-md:h-auto @max-md:min-h-8 @max-md:w-full @max-md:justify-center @max-md:gap-1 @max-md:px-1 @max-md:py-1 @max-md:text-[0.7rem] @max-md:leading-tight {tab ===
				'data-sources'
					? 'bg-background text-foreground shadow-sm'
					: 'hover:text-foreground'}"
			>
				<Database class="size-3.5 shrink-0 @max-md:hidden" />
				<span class="@max-md:hidden">Data sources</span>
				<span class="@md:hidden">Sources</span>
				<span class="ml-1 text-[0.65rem] text-muted-foreground @max-md:hidden">
					{DRASI_COUNTS.sources}
				</span>
			</button>
			<button
				id={tabButtonId("incidents")}
				data-tab="incidents"
				type="button"
				role="tab"
				aria-selected={tab === "incidents"}
				aria-controls={tabPanelId("incidents")}
				tabindex={tab === "incidents" ? 0 : -1}
				onclick={() => setTab("incidents")}
				class="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors @max-md:h-auto @max-md:min-h-8 @max-md:w-full @max-md:justify-center @max-md:gap-1 @max-md:px-1 @max-md:py-1 @max-md:text-[0.7rem] @max-md:leading-tight {tab ===
				'incidents'
					? 'bg-background text-foreground shadow-sm'
					: 'hover:text-foreground'}"
			>
				<Siren class="size-3.5 shrink-0 @max-md:hidden" />
				Incidents
			</button>
		</div>
	</div>

	<div
		id={tabPanelId("system")}
		role="tabpanel"
		aria-labelledby={tabButtonId("system")}
		tabindex="0"
		hidden={tab !== "system"}
		class={tab === "system" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}
	>
		{#if tab === "system"}
			<div class="min-h-[320px] min-w-0 flex-1">
				<TopologyCanvas onSelect={handleSelect} />
			</div>
		{/if}
	</div>
	<div
		id={tabPanelId("queries")}
		role="tabpanel"
		aria-labelledby={tabButtonId("queries")}
		tabindex="0"
		hidden={tab !== "queries"}
		class={tab === "queries" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}
	>
		{#if tab === "queries"}
			<QueriesTab onInspect={inspectNode} />
		{/if}
	</div>
	<div
		id={tabPanelId("data-sources")}
		role="tabpanel"
		aria-labelledby={tabButtonId("data-sources")}
		tabindex="0"
		hidden={tab !== "data-sources"}
		class={tab === "data-sources"
			? "flex min-h-0 flex-1 flex-col overflow-hidden"
			: "hidden"}
	>
		{#if tab === "data-sources"}
			<DataSourcesTab onInspect={inspectNode} />
		{/if}
	</div>
	<div
		id={tabPanelId("incidents")}
		role="tabpanel"
		aria-labelledby={tabButtonId("incidents")}
		tabindex="0"
		hidden={tab !== "incidents"}
		class={tab === "incidents" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}
	>
		{#if tab === "incidents"}
			<IncidentsTab />
		{/if}
	</div>

	<DetailSheet bind:open={sheetOpen} {selection} />
</div>

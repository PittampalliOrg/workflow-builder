<script lang="ts">
	import { onDestroy, onMount, untrack } from "svelte";
	import { AlertTriangle, GitBranch, GitCommit, Github, RefreshCw } from "lucide-svelte";

	import { browser } from "$app/environment";
	import { goto } from "$app/navigation";
	import { page } from "$app/state";

	import GitopsFilters, {
		type StatusFilter,
	} from "$lib/components/gitops/GitopsFilters.svelte";
	import InventoryFooter from "$lib/components/gitops/InventoryFooter.svelte";
	import ServiceDetail from "$lib/components/gitops/ServiceDetail.svelte";
	import ServiceTable from "$lib/components/gitops/ServiceTable.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import {
		buildServiceMatrix,
		ENVIRONMENTS,
		summarizeMatrix,
		summarizeRow,
		type EnvName,
		type ServiceRow,
	} from "$lib/gitops/service-matrix";
	import type { DeploymentMetadataResponse } from "$lib/types/deployment-metadata";
	import { relativeTime } from "$lib/utils/gitops-display";

	import type { PageData } from "./$types";

	type Props = { data: PageData };
	let { data }: Props = $props();

	// Intentionally snapshot the SSR-provided payload once; updates come from
	// the 15-second poll, not from `data` changing.
	let metadata = $state<DeploymentMetadataResponse>(untrack(() => data.initial));
	let tektonBase = $state<string | null>(untrack(() => data.tektonBase));
	const links = untrack(() => data.links);
	let loading = $state(false);
	let errorMessage = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;
	let clockTimer: ReturnType<typeof setInterval> | null = null;
	// Tick every 30s so `relativeTime` ("2m ago", "43m ago") stays fresh without
	// waiting for the 15s metadata poll.
	let now = $state<number>(Date.now());

	function focusSearch() {
		const el = document.querySelector<HTMLInputElement>('input[placeholder^="Filter services"]');
		if (el) {
			el.focus();
			el.select();
		}
	}

	// Filter state
	let search = $state("");
	let statusFilter = $state<StatusFilter>("all");
	// Ryzen column hidden by default (hub inventory doesn't index ryzen).
	let envsVisible = $state<Record<EnvName, boolean>>({
		ryzen: false,
		dev: true,
		staging: true,
	});

	const rows = $derived(
		buildServiceMatrix({
			inventory: metadata.inventory.data,
			releasePins: metadata.gitops.desiredImages,
			live: metadata.live.deployments,
			currentEnv: metadata.environment.name,
		}),
	);

	function rowMatchesStatus(row: ServiceRow, filter: StatusFilter): boolean {
		if (filter === "all") return true;
		if (filter === "sandbox") return row.specialCase === "sandbox-only";
		const overall = summarizeRow(row).overall;
		if (filter === "healthy") return overall === "healthy" || overall === "empty";
		// "attention"
		return overall === "drift" || overall === "degraded";
	}

	const filteredRows = $derived(
		rows.filter((row) => {
			if (search) {
				const needle = search.toLowerCase();
				if (!row.service.toLowerCase().includes(needle)) return false;
			}
			return rowMatchesStatus(row, statusFilter);
		}),
	);

	const summary = $derived(summarizeMatrix(rows));

	// URL-state: ?service=<name>. Falls back to the first row in the filtered
	// list so something is always selected.
	const selectedService = $derived.by(() => {
		const fromUrl = page.url.searchParams.get("service");
		if (fromUrl && filteredRows.some((r) => r.service === fromUrl)) return fromUrl;
		if (fromUrl && rows.some((r) => r.service === fromUrl)) return fromUrl;
		return filteredRows[0]?.service ?? rows[0]?.service ?? null;
	});

	const selectedRow = $derived(
		selectedService ? rows.find((r) => r.service === selectedService) ?? null : null,
	);

	function selectService(service: string) {
		const url = new URL(page.url);
		url.searchParams.set("service", service);
		goto(url.pathname + url.search, {
			replaceState: true,
			noScroll: true,
			keepFocus: true,
		});
	}

	const envLabel = $derived(metadata.environment.name ?? "unknown");
	const stacksShortSha = $derived(metadata.gitops.stacksMain?.shortSha ?? "—");
	const stacksUrl = $derived(metadata.gitops.stacksMain?.url ?? null);

	async function refresh() {
		loading = true;
		try {
			const res = await fetch("/api/v1/gitops/deployment-metadata");
			if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
			metadata = (await res.json()) as DeploymentMetadataResponse;
			const errors = [
				metadata.live.error,
				metadata.gitops.releasePinsError,
				metadata.inventory.error,
			].filter((message): message is string => Boolean(message));
			errorMessage = errors.length ? errors.join(" / ") : null;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	function handleGlobalKey(event: KeyboardEvent) {
		// Press `/` (or Cmd/Ctrl+K) to focus the search — matches Linear / GitHub.
		const target = event.target as HTMLElement | null;
		const isEditable =
			target &&
			(target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.isContentEditable);
		if (isEditable) return;
		if (event.key === "/" || (event.key === "k" && (event.metaKey || event.ctrlKey))) {
			event.preventDefault();
			focusSearch();
		}
	}

	onMount(() => {
		timer = setInterval(() => void refresh(), 15_000);
		clockTimer = setInterval(() => (now = Date.now()), 30_000);
		if (browser) window.addEventListener("keydown", handleGlobalKey);
	});
	onDestroy(() => {
		if (timer) clearInterval(timer);
		if (clockTimer) clearInterval(clockTimer);
		if (browser) window.removeEventListener("keydown", handleGlobalKey);
	});

	// One-line attention summary shown beside the header when the fleet has
	// anything worth flagging. Full issue drill-down lives in the detail pane.
	const attention = $derived.by(() => {
		if (metadata.inventory.error)
			return { tone: "error" as const, text: `Inventory error: ${metadata.inventory.error}` };
		if (summary.degradedApps > 0 || summary.failedBuilds > 0) {
			const parts: string[] = [];
			if (summary.failedBuilds > 0)
				parts.push(`${summary.failedBuilds} failed build${summary.failedBuilds === 1 ? "" : "s"}`);
			if (summary.degradedApps > 0)
				parts.push(`${summary.degradedApps} degraded`);
			return { tone: "error" as const, text: parts.join(" · ") };
		}
		if (summary.driftCount > 0) {
			return {
				tone: "warn" as const,
				text: `${summary.driftCount} drift — rollout in progress`,
			};
		}
		return null;
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
			</div>
			<div class="flex items-center gap-2">
				{#if stacksUrl}
					<a
						class="flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
						href={stacksUrl}
						target="_blank"
						rel="noreferrer"
					>
						<Github class="size-3" />
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
		<GitopsFilters
			{search}
			{statusFilter}
			{envsVisible}
			total={rows.length}
			filtered={filteredRows.length}
			onSearchChange={(v) => (search = v)}
			onStatusFilterChange={(v) => (statusFilter = v)}
			onEnvToggle={(env) => {
				envsVisible = { ...envsVisible, [env]: !envsVisible[env] };
			}}
		/>
	</div>

	<div class="grid flex-1 grid-cols-1 overflow-hidden md:grid-cols-[20rem_1fr] lg:grid-cols-[22rem_1fr]">
		<aside class="border-r bg-background md:border-b-0">
			<ServiceTable
				rows={filteredRows}
				{selectedService}
				onSelect={selectService}
			/>
		</aside>
		<main class="overflow-y-auto bg-muted/10">
			{#if selectedRow}
				<ServiceDetail
					row={selectedRow}
					{tektonBase}
					{envsVisible}
					{links}
					desiredImages={metadata.gitops.desiredImages}
					{now}
				/>
			{:else}
				<div class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
					{filteredRows.length === 0
						? "No services match the current filter."
						: "Select a service to see its deployment detail."}
				</div>
			{/if}
		</main>
	</div>

	<div class="border-t bg-background px-5 py-2">
		<InventoryFooter inventory={metadata.inventory} generatedAt={metadata.generatedAt} />
	</div>
</div>

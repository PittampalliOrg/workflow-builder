<script lang="ts">
	import { onDestroy, onMount, untrack } from "svelte";
	import {
		Activity,
		GitBranch,
		GitCommit,
		RefreshCw,
	} from "lucide-svelte";

	import AttentionBanner from "$lib/components/gitops/AttentionBanner.svelte";
	import BuildActivity from "$lib/components/gitops/BuildActivity.svelte";
	import InventoryFooter from "$lib/components/gitops/InventoryFooter.svelte";
	import PromotionStrip from "$lib/components/gitops/PromotionStrip.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { buildServiceMatrix } from "$lib/gitops/service-matrix";
	import type { DeploymentMetadataResponse } from "$lib/types/deployment-metadata";
	import { relativeTime } from "$lib/utils/gitops-display";

	import type { PageData } from "./$types";

	type Props = { data: PageData };
	let { data }: Props = $props();

	// Intentionally snapshot the SSR-provided payload once; subsequent updates
	// come from the 15-second poll below, not from `data` changing.
	let metadata = $state<DeploymentMetadataResponse>(untrack(() => data.initial));
	let tektonBase = $state<string | null>(untrack(() => data.tektonBase));
	let loading = $state(false);
	let errorMessage = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;

	const rows = $derived(
		buildServiceMatrix({
			inventory: metadata.inventory.data,
			releasePins: metadata.gitops.desiredImages,
			live: metadata.live.deployments,
			currentEnv: metadata.environment.name,
		}),
	);

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

	onMount(() => {
		timer = setInterval(() => void refresh(), 15_000);
	});
	onDestroy(() => {
		if (timer) clearInterval(timer);
	});
</script>

<svelte:head>
	<title>GitOps · Workflow Builder</title>
</svelte:head>

<div class="flex h-full flex-col overflow-hidden">
	<header class="border-b px-6 py-4">
		<div class="flex items-start justify-between gap-4">
			<div>
				<div class="flex items-center gap-2">
					<GitBranch class="size-5 text-muted-foreground" />
					<h1 class="text-xl font-semibold">GitOps</h1>
					<Badge variant="outline" class="text-[0.65rem]">
						{envLabel}
					</Badge>
				</div>
				<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
					<span>Dev & build & deploy status for the workflow-builder system</span>
					<span class="text-muted-foreground/40">/</span>
					<span class="flex items-center gap-1">
						<GitCommit class="size-3" />
						stacks/main
						{#if stacksUrl}
							<a class="font-mono text-primary hover:underline" href={stacksUrl} target="_blank" rel="noreferrer">
								{stacksShortSha}
							</a>
						{:else}
							<span class="font-mono">{stacksShortSha}</span>
						{/if}
					</span>
				</div>
			</div>
			<div class="flex items-center gap-2">
				<span class="text-[0.7rem] text-muted-foreground">
					Updated {relativeTime(metadata.generatedAt)}
				</span>
				<Button variant="outline" onclick={refresh} disabled={loading}>
					{#if loading}
						<RefreshCw class="size-4 animate-spin" />
					{:else}
						<RefreshCw class="size-4" />
					{/if}
					Refresh
				</Button>
			</div>
		</div>
	</header>

	<div class="flex-1 space-y-6 overflow-auto p-6">
		<AttentionBanner
			{rows}
			tektonBase={tektonBase}
			inventoryError={metadata.inventory.error}
		/>

		{#if errorMessage}
			<div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
				{errorMessage}
			</div>
		{/if}

		<section class="space-y-3">
			<div class="flex items-baseline gap-2">
				<Activity class="size-4 text-muted-foreground" />
				<h2 class="text-base font-semibold">Promotion flow</h2>
				<span class="text-[0.68rem] text-muted-foreground">
					{rows.length} services · ryzen → dev → staging
				</span>
			</div>

			<div class="space-y-2">
				{#each rows as row (row.service)}
					<PromotionStrip {row} />
				{/each}
			</div>
		</section>

		<BuildActivity {rows} {tektonBase} />

		<InventoryFooter inventory={metadata.inventory} generatedAt={metadata.generatedAt} />
	</div>
</div>

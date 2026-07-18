<script lang="ts">
	import {
		AlertTriangle,
		ArrowRight,
		CheckCircle2,
		Container,
		ExternalLink,
		HelpCircle,
	} from "@lucide/svelte";

	import { Skeleton } from "$lib/components/ui/skeleton";
	import type { GitopsPageLinks } from "$lib/gitops/links";
	import { buildPreviewPlatformView } from "$lib/gitops/preview-platform";
	import type { FleetDriftExtras } from "$lib/types/deployment-metadata";

	type Props = {
		extras: FleetDriftExtras | null;
		/** True while the extras query has not resolved for the first time. */
		loading: boolean;
		links: GitopsPageLinks;
	};

	let { extras, loading, links }: Props = $props();

	const view = $derived(buildPreviewPlatformView(extras));

	const brokerYamlUrl = $derived(
		`${links.stacksRepo}/blob/main/packages/components/workloads/dev-preview-platform/Deployment-preview-control-broker.yaml`,
	);
	const releasePinsUrl = $derived(
		`${links.stacksRepo}/blob/main/${links.releasePinsPath}`,
	);
</script>

<!-- Preview platform: dev-preview-platform pin revision vs stacks main, and the
     broker image digest vs release-pins digest (the broker-skew datum). -->
{#if loading && !extras}
	<div class="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
		<Container class="size-4 shrink-0 text-muted-foreground" />
		<div class="flex-1 space-y-1.5">
			<Skeleton class="h-3.5 w-56" />
			<Skeleton class="h-3 w-80" />
		</div>
	</div>
{:else if view.state === "skew"}
	<div
		class="rounded-lg border border-amber-400/60 bg-amber-50 px-4 py-3 dark:border-amber-500/40 dark:bg-amber-950/30"
		role="alert"
	>
		<div class="flex items-start gap-3">
			<AlertTriangle class="mt-0.5 size-5 shrink-0 text-amber-600 dark:text-amber-400" />
			<div class="min-w-0 flex-1 space-y-1.5">
				<div class="flex flex-wrap items-center gap-2">
					<span class="text-sm font-semibold text-amber-900 dark:text-amber-100">
						SKEW · {view.headline}
					</span>
				</div>
				<p class="text-xs text-amber-800 dark:text-amber-200">{view.detail}</p>
				<div class="flex flex-wrap items-center gap-2 text-xs">
					<a
						class="inline-flex items-center gap-1 font-mono text-amber-900 hover:underline dark:text-amber-100"
						href={brokerYamlUrl}
						target="_blank"
						rel="noreferrer"
						title="Broker Deployment on stacks main"
					>
						broker {view.brokerDigestShort}
						<ExternalLink class="size-3" />
					</a>
					<ArrowRight class="size-3 text-amber-700 dark:text-amber-300" />
					<a
						class="inline-flex items-center gap-1 font-mono text-amber-900 hover:underline dark:text-amber-100"
						href={releasePinsUrl}
						target="_blank"
						rel="noreferrer"
						title="release-pins digests.workflow-builder"
					>
						release-pins {view.releasePinsDigestShort}
						<ExternalLink class="size-3" />
					</a>
				</div>
				{#if view.remedy}
					<p class="text-xs font-medium text-amber-900 dark:text-amber-100">{view.remedy}</p>
				{/if}
			</div>
		</div>
	</div>
{:else}
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-4 py-2.5">
		<span class="inline-flex items-center gap-1.5 text-xs font-medium">
			<Container class="size-3.5 text-muted-foreground" />
			Preview platform
		</span>
		{#if view.state === "in-sync"}
			<span class="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
				<CheckCircle2 class="size-3.5" />
				broker matches release-pins
			</span>
		{:else}
			<span
				class="inline-flex items-center gap-1 text-xs text-muted-foreground"
				title={view.detail}
			>
				<HelpCircle class="size-3.5" />
				state unknown
			</span>
		{/if}
		<span class="font-mono text-[0.7rem] text-muted-foreground" title="Broker image digest">
			{view.brokerDigestShort}
		</span>
		{#if view.pinRevision}
			<span
				class="font-mono text-[0.7rem] text-muted-foreground"
				title="Live workflow-builder-image-pins-preview ConfigMap pins-hash"
			>
				pins {view.pinRevision.slice(0, 12)}
			</span>
		{/if}
		{#if view.stacksMainShortSha && view.stacksMainUrl}
			<a
				class="ml-auto inline-flex items-center gap-1 font-mono text-[0.7rem] text-muted-foreground hover:text-foreground"
				href={view.stacksMainUrl}
				target="_blank"
				rel="noreferrer"
			>
				stacks/main {view.stacksMainShortSha}
				<ExternalLink class="size-3" />
			</a>
		{/if}
	</div>
{/if}

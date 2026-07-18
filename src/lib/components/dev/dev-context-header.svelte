<script lang="ts">
	import { Button, buttonVariants } from "$lib/components/ui/button";
	import { Badge } from "$lib/components/ui/badge";
	import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "$lib/components/ui/tooltip";
	import {
		Activity,
		CircleCheck,
		GitBranch,
		History,
		Plus,
		Radio,
		RefreshCw,
		ServerCog,
		TimerReset,
		TriangleAlert,
	} from "@lucide/svelte";
	import PreviewDriftSummaryChips from "$lib/components/dev/preview-drift-summary-chips.svelte";
	import { summarizeDevOperations, type DevSessionGroupLike } from "$lib/dev/dev-operations-view";
	import type {
		PreviewDriftOverview,
		VclusterPreviewCounts,
		VclusterPreviewSummary,
	} from "$lib/types/dev-previews";

	let {
		previews = [],
		groups = [],
		counts = null,
		previewEnvironment = null,
		previewRunFeedEnabled = false,
		drift = null,
		driftLoading = false,
		slug,
		lastRefreshedAt,
		refreshing = false,
		onrefresh,
		onlaunch,
	}: {
		previews?: VclusterPreviewSummary[];
		groups?: DevSessionGroupLike[];
		counts?: VclusterPreviewCounts | null;
		previewEnvironment?: {
			id: string;
			profile: string;
			platformRevision: string | null;
			sourceRevision: string | null;
			origin: string | null;
		} | null;
		previewRunFeedEnabled?: boolean;
		/** Fleet drift overview (control plane only) for the summary chips. */
		drift?: PreviewDriftOverview | null;
		driftLoading?: boolean;
		slug: string;
		lastRefreshedAt: number | null;
		refreshing?: boolean;
		onrefresh: () => void;
		onlaunch: () => void;
	} = $props();

	const summary = $derived(summarizeDevOperations(previews, groups, counts));
	const contextLabel = $derived(previewEnvironment ? previewEnvironment.id : "Physical dev control plane");

	function shortRevision(value: string | null): string {
		return value?.slice(0, 10) ?? "not reported";
	}
</script>

<section class="border-b bg-background" aria-labelledby="dev-operations-title">
	<div class="flex flex-wrap items-start justify-between gap-4 px-5 py-4 lg:px-6">
		<div class="min-w-0">
			<div class="flex flex-wrap items-center gap-2">
				<div class="flex size-8 items-center justify-center rounded-md border bg-muted/40">
					<ServerCog class="size-4 text-cyan-600 dark:text-cyan-400" />
				</div>
				<h1 id="dev-operations-title" class="text-xl font-semibold">Development</h1>
				<Badge variant="outline" class="max-w-full truncate font-mono text-[10px]">{contextLabel}</Badge>
			</div>
			<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
				<span class="inline-flex items-center gap-1.5">
					<span class="size-1.5 rounded-full bg-cyan-500"></span>
					Lifecycle snapshots every 5s
				</span>
				<span class="inline-flex items-center gap-1.5">
					<Radio class="size-3.5 {previewRunFeedEnabled ? 'text-emerald-500' : ''}" />
						{previewRunFeedEnabled ? "Fleet workflow events enabled" : "Fleet workflow events unavailable"}
				</span>
				{#if lastRefreshedAt}
					<time datetime={new Date(lastRefreshedAt).toISOString()}>
						Updated {new Date(lastRefreshedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
					</time>
				{:else}
					<span>Refreshing lifecycle data</span>
				{/if}
			</div>
			{#if drift || driftLoading}
				<PreviewDriftSummaryChips overview={drift} loading={driftLoading} class="mt-2" />
			{/if}
		</div>

		<div class="flex flex-wrap items-center gap-2">
			<Button variant="outline" size="sm" href="/admin/gitops?tab=overview">
				<GitBranch class="size-4" /> Delivery
			</Button>
			<Button variant="outline" size="sm" href={`/workspaces/${slug}/previews/archived`}>
				<History class="size-4" /> Archives
			</Button>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger
						class={buttonVariants({ variant: "outline", size: "icon-lg" })}
						disabled={refreshing}
						onclick={onrefresh}
						aria-label="Refresh development state"
					>
						<RefreshCw class="size-4 {refreshing ? 'motion-safe:animate-spin' : ''}" />
					</TooltipTrigger>
					<TooltipContent>Refresh development state</TooltipContent>
				</Tooltip>
			</TooltipProvider>
			<Button size="sm" onclick={onlaunch}>
				<Plus class="size-4" /> Start coding session
			</Button>
		</div>
	</div>

	{#if previewEnvironment}
		<div class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-cyan-500/5 px-5 py-2 text-xs lg:px-6">
			<span class="font-medium text-cyan-800 dark:text-cyan-200">Inside isolated preview</span>
			<span>{previewEnvironment.profile}</span>
			<span class="font-mono text-muted-foreground">platform {shortRevision(previewEnvironment.platformRevision)}</span>
			<span class="font-mono text-muted-foreground">source {shortRevision(previewEnvironment.sourceRevision)}</span>
		</div>
	{/if}

	<div class="grid grid-cols-2 border-t sm:grid-cols-5" aria-live="polite">
		<div class="min-w-0 border-r px-5 py-3">
			<div class="flex items-center gap-2 text-xs text-muted-foreground"><CircleCheck class="size-3.5 text-emerald-500" /> Ready</div>
			<div class="mt-1 text-xl font-semibold tabular-nums">{summary.ready}</div>
		</div>
		<div class="min-w-0 border-r px-5 py-3">
			<div class="flex items-center gap-2 text-xs text-muted-foreground"><TimerReset class="size-3.5 text-amber-500" /> Provisioning</div>
			<div class="mt-1 text-xl font-semibold tabular-nums">{summary.provisioning}</div>
		</div>
		<div class="min-w-0 border-r px-5 py-3">
			<div class="flex items-center gap-2 text-xs text-muted-foreground"><TriangleAlert class="size-3.5 text-red-500" /> Attention</div>
			<div class="mt-1 text-xl font-semibold tabular-nums">{summary.attention}</div>
		</div>
		<div class="min-w-0 border-r px-5 py-3">
			<div class="flex items-center gap-2 text-xs text-muted-foreground"><Activity class="size-3.5 text-violet-500" /> Sessions</div>
			<div class="mt-1 text-xl font-semibold tabular-nums">{summary.liveSessions}</div>
		</div>
		<div class="col-span-2 min-w-0 px-5 py-3 sm:col-span-1">
			<div class="flex items-center gap-2 text-xs text-muted-foreground">
				<ServerCog class="size-3.5 text-cyan-500" />
				{previewEnvironment ? "Scope" : "Capacity"}
			</div>
			<div class="mt-1 text-xl font-semibold tabular-nums">
				{previewEnvironment ? "Isolated" : summary.previewCapacity}
			</div>
			{#if !previewEnvironment && counts}
				<div class="mt-0.5 truncate text-[10px] tabular-nums text-muted-foreground">
					awake · total {counts.total}/{counts.totalMax > 0 ? counts.totalMax : "∞"}{counts.slept > 0 ? ` · ${counts.slept} slept` : ""}
				</div>
			{/if}
		</div>
	</div>
</section>

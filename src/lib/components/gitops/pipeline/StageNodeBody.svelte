<script lang="ts">
	import { getContext } from "svelte";
	import {
		Clock3,
		ExternalLink,
		GitMerge,
		GitPullRequestArrow,
		Hourglass,
		Radio,
		PauseCircle,
		TimerReset,
	} from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import {
		PIPELINE_HOVER_CONTEXT,
		PIPELINE_LINKS_CONTEXT,
		type PipelineHoverContext,
		type PipelineLinks,
	} from "$lib/gitops/pipeline-layout";
	import { pipelineActivityTone, toneClasses } from "$lib/gitops/activity-tone";
	import { isFlowing } from "$lib/gitops/gitops-flow.svelte";
	import { nowTick } from "$lib/gitops/gitops-tick.svelte";
	import { buildVisual, healthVisual, promotionVisual } from "$lib/gitops/kargo-status";
	import type { PipelineStage } from "$lib/gitops/pipeline-types";
	import {
		formatAbsoluteTime,
		formatDurationMs,
		relativeTime,
		shortSha,
		shortTag,
		tektonPipelineRunUrl,
	} from "$lib/utils/gitops-display";

	type Props = {
		stage: PipelineStage;
		color?: string;
		selected?: boolean;
		highlight?: boolean;
		/** Identity-colored ring: this stage holds the selected freight. */
		freightRing?: boolean;
	};
	let { stage, color, selected = false, highlight = false, freightRing = false }: Props = $props();

	const hover = getContext<PipelineHoverContext | undefined>(PIPELINE_HOVER_CONTEXT);
	const links = getContext<PipelineLinks | undefined>(PIPELINE_LINKS_CONTEXT);

	const health = $derived(healthVisual(stage.health));
	const promo = $derived(promotionVisual(stage.promotionPhase));
	const drift = $derived(
		stage.drift === "pending_rollout" ||
			(stage.liveTag && stage.desiredTag && stage.liveTag !== stage.desiredTag),
	);
	// argocd-agent mirrors each spoke's apps into a hub-side namespace named after
	// the agent (ryzen / dev / staging), e.g. ryzen/ryzen-workflow-builder — so the
	// path namespace is the env, not `argocd`. The release-pins bundle and dormant
	// lanes have no backing Argo app.
	const argoUrl = $derived(
		links?.argoCdBase && !stage.dormant && stage.warehouse !== "release-pins"
			? `${links.argoCdBase.replace(/\/+$/, "")}/applications/${stage.env}/${stage.env}-${stage.warehouse}`
			: null,
	);
	// Relative-time link: stacks commit for promoted (hydrated) stages, else the
	// source commit that produced the desired image.
	const timeUrl = $derived(
		stage.promoterHydratedSha && links?.stacksRepo
			? `${links.stacksRepo}/commit/${stage.promoterHydratedSha}`
			: stage.commitSha && links?.workflowBuilderRepo
				? `${links.workflowBuilderRepo}/commit/${stage.commitSha}`
				: null,
	);

	// Image-build chip (inventory-sourced Tekton outer-loop run). Persistent,
	// distinct from the transient `activity` event chip. `durationMs` is final once
	// built/failed; while building we tick elapsed against the shared clock.
	const buildViz = $derived(stage.build ? buildVisual(stage.build.phase) : null);
	const buildElapsedMs = $derived.by(() => {
		const b = stage.build;
		if (!b) return null;
		if (b.durationMs != null) return b.durationMs;
		if (b.startedAt) {
			const started = Date.parse(b.startedAt);
			if (Number.isFinite(started)) return Math.max(0, nowTick() - started);
		}
		return null;
	});
	const buildUrl = $derived(tektonPipelineRunUrl(links?.tektonBase, stage.build?.pipelineRun));

	function stop(e: Event) {
		e.stopPropagation();
	}
</script>

<div
	role="group"
	onmouseenter={() => hover?.setHovered(stage.warehouse)}
	onmouseleave={() => hover?.setHovered(null)}
	class="flex h-[168px] w-[270px] flex-col overflow-hidden rounded-xl border border-border/70 bg-card text-card-foreground shadow-sm transition-shadow hover:shadow-md {selected
		? 'ring-2 ring-primary/40'
		: ''} {highlight ? 'border-amber-400 ring-2 ring-amber-400 shadow-[0_0_12px_2px_rgba(245,197,24,0.55)]' : ''} {stage.dormant ? 'border-dashed opacity-80' : ''} {isFlowing(stage.name) ? 'gitops-flow' : ''}"
	style="{color ? `border-left: 3px solid ${color};` : ''}{freightRing && color
		? `box-shadow: 0 0 0 2.5px ${color};`
		: ''}"
>
	<!-- Header: environment name, identity dot, subtle tint, ArgoCD link -->
	<div
		class="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2"
		style={color ? `background:${color}0d` : ""}
	>
		<div class="flex min-w-0 items-center gap-1.5">
			<span class="size-2 shrink-0 rounded-full" style={color ? `background:${color}` : ""}></span>
			<span class="truncate text-[0.8rem] font-semibold">{stage.env}</span>
		</div>
		{#if argoUrl}
			<a
				href={argoUrl}
				target="_blank"
				rel="noreferrer"
				onclick={stop}
				class="shrink-0 text-muted-foreground transition-colors hover:text-primary"
				title="Open ArgoCD application"
			>
				<ExternalLink class="size-3.5" />
			</a>
		{:else}
			<ExternalLink class="size-3.5 shrink-0 text-muted-foreground/50" />
		{/if}
	</div>

	{#if stage.controlFlow}
		<div class="flex flex-1 flex-col items-center justify-center gap-1.5 px-3 text-center text-[0.7rem] text-muted-foreground">
			<PauseCircle class="size-5 opacity-70" />
			<span class="font-medium">{stage.dormant ? "Dormant lane" : "Control flow"}</span>
		</div>
	{:else}
		<div class="flex flex-1 flex-col gap-1.5 px-3 py-2">
			<!-- Primary status line: health (prominent) + sync/promotion compact on right -->
			<div class="flex items-center justify-between gap-2">
				<span class="flex min-w-0 items-center gap-1.5" style={`color:${health.color}`}>
					{#if health.icon}{@const Icon = health.icon}<Icon
							class={health.spin ? "size-3.5 shrink-0 animate-spin" : "size-3.5 shrink-0"}
						/>{/if}
					<span class="truncate text-[0.8rem] font-semibold">{health.label}</span>
				</span>
				<div class="flex shrink-0 items-center gap-1.5">
					{#if stage.syncStatus}
						<span class="text-[0.58rem] uppercase tracking-wider text-muted-foreground" title={`Sync: ${stage.syncStatus}`}>
							{stage.syncStatus}
						</span>
					{/if}
					{#if stage.source && stage.source !== "inventory"}
						<span
							class="rounded px-1 text-[0.55rem] font-medium uppercase tracking-wider {stage.source === 'pin-only'
								? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
								: 'bg-muted text-muted-foreground'}"
							title={stage.source === "pin-only"
								? "Pinned in git but no reconciled hub-inventory data — health/sync are unknown, not confirmed"
								: "Live pod data only (no hub-inventory snapshot)"}
						>
							{stage.source === "pin-only" ? "pinned" : "live-only"}
						</span>
					{/if}
					{#if promo}
						{@const PIcon = promo.icon}
						<PIcon
							class={promo.spin ? "size-3.5 animate-spin" : "size-3.5"}
							style={`color:${promo.color}`}
							title={`Promotion ${promo.label}`}
						/>
					{/if}
				</div>
			</div>

			<!-- Roll-up (release-train bundle stages) -->
			{#if stage.rollup}
				<div class="flex flex-wrap items-center gap-1">
					<Badge variant="secondary" class="h-4 rounded px-1.5 text-[0.58rem]">{stage.rollup.synced} synced</Badge>
					{#if stage.rollup.drift > 0}
						<Badge variant="outline" class="h-4 rounded border-amber-400 px-1.5 text-[0.58rem] text-amber-700 dark:text-amber-300">{stage.rollup.drift} drift</Badge>
					{/if}
					{#if stage.rollup.degraded > 0}
						<Badge variant="destructive" class="h-4 rounded px-1.5 text-[0.58rem]">{stage.rollup.degraded} degraded</Badge>
					{/if}
				</div>
			{/if}

			<!-- Current freight: desired tag chip + drift -->
			{#if stage.desiredTag}
				<div class="flex items-center gap-1.5">
					<span class="truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[0.68rem]" title={stage.desiredTag}>
						{shortTag(stage.desiredTag)}
					</span>
					{#if drift && stage.liveTag}
						<span class="flex min-w-0 items-center gap-1 truncate font-mono text-[0.62rem] text-amber-600 dark:text-amber-400" title={`live ${stage.liveTag}`}>
							<GitMerge class="size-3 shrink-0" />{shortTag(stage.liveTag)}
						</span>
					{/if}
				</div>
			{/if}

			<!-- Image build (inventory-sourced Tekton outer-loop run that produced the
			     desired image). Persistent; built✓+duration / building+elapsed / failed. -->
			{#if buildViz && stage.build}
				{@const BIcon = buildViz.icon}
				<div
					class="flex min-w-0 items-center gap-1.5 text-[0.62rem]"
					style={`color:${buildViz.color}`}
					title={`Image build ${buildViz.label}${stage.build.pipelineRun ? ` · ${stage.build.pipelineRun}` : ""}${buildElapsedMs != null ? ` · ${formatDurationMs(buildElapsedMs)}` : ""}`}
				>
					<BIcon class={buildViz.spin ? "size-3 shrink-0 animate-spin" : "size-3 shrink-0"} />
					<span class="truncate font-medium">
						{buildViz.label}{#if buildElapsedMs != null}<span class="font-normal opacity-80"> · {formatDurationMs(buildElapsedMs)}{stage.build.phase === "building" ? "…" : ""}</span>{/if}
					</span>
					{#if buildUrl}
						<a
							href={buildUrl}
							target="_blank"
							rel="noreferrer"
							onclick={stop}
							class="ml-auto shrink-0 opacity-80 transition-opacity hover:opacity-100"
							title="Open build in Tekton Dashboard"
						>
							<ExternalLink class="size-3" />
						</a>
					{/if}
				</div>
			{/if}

			<!-- Promoter in-flight (C1/C2): a distinct proposed freight is soaking /
			     awaiting a gate. Only Promoter-gated stages (dev) carry this. -->
			{#if stage.promotion?.inFlight}
				<div class="flex flex-col gap-1 rounded-md border border-amber-400/60 bg-amber-50/70 px-2 py-1.5 dark:bg-amber-950/30">
					<div class="flex items-center gap-1.5 text-[0.62rem] font-medium text-amber-700 dark:text-amber-300">
						<GitPullRequestArrow class="size-3 shrink-0" />
						<span class="truncate font-mono" title={stage.promotion.proposedTag ?? "next freight"}>
							→ {stage.promotion.proposedTag ? shortSha(stage.promotion.proposedTag) : "next"}
						</span>
						{#if stage.promotion.pullRequest?.url}
							<a
								href={stage.promotion.pullRequest.url}
								target="_blank"
								rel="noreferrer"
								onclick={stop}
								class="ml-auto shrink-0 transition-colors hover:text-primary"
								title={`Promotion PR${stage.promotion.pullRequest.state ? ` (${stage.promotion.pullRequest.state})` : ""}`}
							>
								<ExternalLink class="size-3" />
							</a>
						{/if}
					</div>
					{#if stage.promotion.soak}
						<div class="flex items-center gap-1.5 text-[0.6rem] text-amber-700/90 dark:text-amber-300/90" title="Soak / verification countdown">
							<TimerReset class="size-2.5 shrink-0" />soak {stage.promotion.soak.label}
						</div>
					{:else if stage.promotion.stalledOn}
						<div class="flex items-center gap-1.5 text-[0.6rem] text-amber-700/90 dark:text-amber-300/90" title="Promotion gate not yet satisfied">
							<Hourglass class="size-2.5 shrink-0" />waiting: {stage.promotion.stalledOn}
						</div>
					{/if}
				</div>
			{:else if stage.awaitingReconcile}
				<div class="flex items-center gap-1.5 text-[0.6rem] text-muted-foreground" title="Pinned/sourced but no reconciled inventory evidence yet">
					<Hourglass class="size-2.5 shrink-0" />awaiting reconcile
				</div>
			{/if}

			<!-- Secondary detail: gate (soak) folded with hydrated sha -->
			{#if stage.gate || stage.promoterHydratedSha}
				<div class="flex min-w-0 items-center gap-2 text-[0.6rem] text-muted-foreground">
					{#if stage.gate}
						<span class="flex min-w-0 items-center gap-1 truncate" title={`${stage.gate.label}${stage.gate.phase ? `: ${stage.gate.phase}` : ""}`}>
							<TimerReset class="size-3 shrink-0" />{stage.gate.label}{stage.gate.phase ? `: ${stage.gate.phase}` : ""}
						</span>
					{/if}
					{#if stage.promoterHydratedSha}
						<span class="ml-auto shrink-0 font-mono" title={stage.promoterHydratedSha}>
							{shortSha(stage.promoterHydratedSha)}
						</span>
					{/if}
				</div>
			{/if}

			<!-- Live-activity signal: tone-coloured event row (shared tone language) -->
			{#if stage.activity}
				{@const tone = pipelineActivityTone(stage.activity, nowTick())}
				{@const tc = toneClasses(tone)}
				<div
					class="flex items-center gap-1.5 rounded-md border-l-[3px] px-2 py-1 text-[0.62rem] {tc.border} {tc.bg} {tc.text}"
					title={`${stage.activity.activityType} · ${relativeTime(stage.activity.observedAt, nowTick())}${stage.activity.message ? ` · ${stage.activity.message}` : ""}`}
				>
					{#if tone === "active"}
						<Radio class="size-2.5 shrink-0 animate-pulse" />
					{:else}
						<span class="size-1.5 shrink-0 rounded-full bg-current opacity-70"></span>
					{/if}
					<span class="truncate font-medium">{stage.activity.phase ?? stage.activity.activityType}</span>
					<span class="ml-auto shrink-0 opacity-70">{relativeTime(stage.activity.observedAt, nowTick())}</span>
				</div>
			{/if}

			<!-- Footer: updated time pinned to bottom (links to the relevant commit) -->
			{#if stage.updatedAt}
				<div class="mt-auto flex items-center gap-1.5 pt-1 text-[0.6rem] text-muted-foreground" title={formatAbsoluteTime(stage.updatedAt, nowTick())}>
					<Clock3 class="size-2.5 shrink-0" />
					{#if timeUrl}
						<a href={timeUrl} target="_blank" rel="noreferrer" onclick={stop} class="transition-colors hover:text-primary hover:underline">
							{relativeTime(stage.updatedAt, nowTick())}
						</a>
					{:else}
						{relativeTime(stage.updatedAt, nowTick())}
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

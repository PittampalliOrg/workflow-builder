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
	import { healthVisual, promotionVisual } from "$lib/gitops/kargo-status";
	import type { PipelineStage } from "$lib/gitops/pipeline-types";
	import { formatAbsoluteTime, relativeTime, shortSha, shortTag } from "$lib/utils/gitops-display";

	type Props = { stage: PipelineStage; color?: string; selected?: boolean; highlight?: boolean };
	let { stage, color, selected = false, highlight = false }: Props = $props();

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

	function stop(e: Event) {
		e.stopPropagation();
	}
</script>

<div
	role="group"
	onmouseenter={() => hover?.setHovered(stage.warehouse)}
	onmouseleave={() => hover?.setHovered(null)}
	class="flex h-[168px] w-[270px] flex-col overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm transition hover:shadow-md {selected
		? 'ring-2 ring-primary/50'
		: ''} {highlight ? 'border-amber-400 ring-2 ring-amber-400 shadow-[0_0_12px_2px_rgba(245,197,24,0.55)]' : ''} {stage.dormant ? 'border-dashed opacity-80' : ''}"
	style={color ? `border-left: 4px solid ${color};` : ""}
>
	<!-- Header: environment name, identity colour band, ArgoCD link -->
	<div
		class="flex items-center justify-between gap-2 border-b px-3 py-1.5"
		style={color ? `background:${color}1a` : ""}
	>
		<div class="flex min-w-0 items-center gap-1.5">
			<span class="size-2 shrink-0 rounded-full" style={color ? `background:${color}` : ""}></span>
			<span class="truncate text-xs font-semibold">{stage.env}</span>
		</div>
		{#if argoUrl}
			<a
				href={argoUrl}
				target="_blank"
				rel="noreferrer"
				onclick={stop}
				class="shrink-0 text-muted-foreground hover:text-primary"
				title="Open ArgoCD application"
			>
				<ExternalLink class="size-3" />
			</a>
		{:else}
			<ExternalLink class="size-3 shrink-0 text-muted-foreground" />
		{/if}
	</div>

	{#if stage.controlFlow}
		<div class="flex flex-1 flex-col items-center justify-center gap-1 px-3 text-center text-[0.68rem] text-muted-foreground">
			<PauseCircle class="size-4" />
			<span>{stage.dormant ? "Dormant lane" : "Control flow"}</span>
		</div>
	{:else}
		<div class="flex flex-1 flex-col gap-1.5 px-3 py-2 text-[0.7rem]">
			<!-- Health + promotion phase -->
			<div class="flex items-center justify-between gap-2">
				<span class="flex items-center gap-1" style={`color:${health.color}`}>
					{#if health.icon}{@const Icon = health.icon}<Icon
							class={health.spin ? "size-3 animate-spin" : "size-3"}
						/>{/if}
					<span class="font-medium">{health.label}</span>
				</span>
				{#if promo}
					{@const PIcon = promo.icon}
					<span class="flex items-center gap-1 text-muted-foreground" title={`Promotion ${promo.label}`}>
						<PIcon class={promo.spin ? "size-3 animate-spin" : "size-3"} style={`color:${promo.color}`} />
					</span>
				{/if}
			</div>

			<!-- Roll-up (release-train bundle stages) -->
			{#if stage.rollup}
				<div class="flex flex-wrap items-center gap-1">
					<Badge variant="secondary" class="h-4 px-1 text-[0.58rem]">{stage.rollup.synced} synced</Badge>
					{#if stage.rollup.drift > 0}
						<Badge variant="outline" class="h-4 border-amber-400 px-1 text-[0.58rem] text-amber-700 dark:text-amber-300">{stage.rollup.drift} drift</Badge>
					{/if}
					{#if stage.rollup.degraded > 0}
						<Badge variant="destructive" class="h-4 px-1 text-[0.58rem]">{stage.rollup.degraded} degraded</Badge>
					{/if}
				</div>
			{/if}

			<!-- Current freight: desired tag + drift -->
			{#if stage.desiredTag}
				<div class="truncate font-mono text-[0.66rem]" title={stage.desiredTag}>
					{shortTag(stage.desiredTag)}
				</div>
			{/if}
			{#if drift && stage.liveTag}
				<div class="flex items-center gap-1 truncate font-mono text-[0.62rem] text-amber-600 dark:text-amber-400" title={`live ${stage.liveTag}`}>
					<GitMerge class="size-3 shrink-0" />live {shortTag(stage.liveTag)}
				</div>
			{/if}

			<!-- Promoter in-flight (C1/C2): a distinct proposed freight is soaking /
			     awaiting a gate. Only Promoter-gated stages (dev) carry this. -->
			{#if stage.promotion?.inFlight}
				<div class="flex flex-col gap-0.5 rounded-md border border-amber-400/60 bg-amber-50/70 px-1.5 py-1 dark:bg-amber-950/30">
					<div class="flex items-center gap-1 text-[0.62rem] font-medium text-amber-700 dark:text-amber-300">
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
								class="ml-auto shrink-0 hover:text-primary"
								title={`Promotion PR${stage.promotion.pullRequest.state ? ` (${stage.promotion.pullRequest.state})` : ""}`}
							>
								<ExternalLink class="size-3" />
							</a>
						{/if}
					</div>
					{#if stage.promotion.soak}
						<div class="flex items-center gap-1 text-[0.6rem] text-amber-700/90 dark:text-amber-300/90" title="Soak / verification countdown">
							<TimerReset class="size-2.5 shrink-0" />soak {stage.promotion.soak.label}
						</div>
					{:else if stage.promotion.stalledOn}
						<div class="flex items-center gap-1 text-[0.6rem] text-amber-700/90 dark:text-amber-300/90" title="Promotion gate not yet satisfied">
							<Hourglass class="size-2.5 shrink-0" />waiting: {stage.promotion.stalledOn}
						</div>
					{/if}
				</div>
			{:else if stage.awaitingReconcile}
				<div class="flex items-center gap-1 text-[0.6rem] text-muted-foreground" title="Pinned/sourced but no reconciled inventory evidence yet">
					<Hourglass class="size-2.5 shrink-0" />awaiting reconcile
				</div>
			{/if}

			<!-- Gate (soak) + promoter info -->
			{#if stage.gate}
				<div class="flex items-center gap-1 text-[0.62rem] text-muted-foreground">
					<TimerReset class="size-3" />
					{stage.gate.label}{stage.gate.phase ? `: ${stage.gate.phase}` : ""}
				</div>
			{/if}
			{#if stage.activity}
				<div
					class="flex items-center gap-1 rounded-sm px-1 py-0.5 text-[0.6rem] {stage.activity.failed
						? 'bg-destructive/10 text-destructive'
						: stage.activity.active
							? 'bg-sky-500/10 text-sky-700 dark:text-sky-300'
							: 'bg-muted text-muted-foreground'}"
					title={stage.activity.message ?? stage.activity.reason ?? stage.activity.activityType}
				>
					<Radio class="size-2.5 shrink-0 {stage.activity.active ? 'animate-pulse' : ''}" />
					<span class="truncate">{stage.activity.phase ?? stage.activity.activityType}</span>
				</div>
			{/if}
			{#if stage.promoterHydratedSha}
				<div class="truncate font-mono text-[0.6rem] text-muted-foreground" title={stage.promoterHydratedSha}>
					hydrated {shortSha(stage.promoterHydratedSha)}
				</div>
			{/if}

			<!-- Updated time (links to the relevant commit) -->
			{#if stage.updatedAt}
				<div class="mt-auto flex items-center gap-1 text-[0.6rem] text-muted-foreground" title={formatAbsoluteTime(stage.updatedAt)}>
					<Clock3 class="size-2.5" />
					{#if timeUrl}
						<a href={timeUrl} target="_blank" rel="noreferrer" onclick={stop} class="hover:text-primary hover:underline">
							{relativeTime(stage.updatedAt)}
						</a>
					{:else}
						{relativeTime(stage.updatedAt)}
					{/if}
				</div>
			{/if}
		</div>
	{/if}
</div>

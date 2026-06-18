<script lang="ts">
	import {
		AlertTriangle,
		Clock3,
		ExternalLink,
		Filter,
		GitBranch,
		GitPullRequestArrow,
		Package,
		Radio,
		Route,
	} from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import {
		CHANGE_JOURNEY_FILTERS,
		filterChangeJourneys,
		type ChangeJourney,
		type ChangeJourneyFilter,
		type ChangeJourneySelection,
		type ChangeJourneyStatus,
		type ChangeJourneyStepState,
	} from "$lib/gitops/change-journey";
	import { relativeTime, shortSha, shortTag } from "$lib/utils/gitops-display";

	type Props = {
		journeys: ChangeJourney[];
		filter: ChangeJourneyFilter;
		selectedJourneyId?: string | null;
		now: number;
		onFilter: (filter: ChangeJourneyFilter) => void;
		onSelect: (journeyId: string | null, selection?: ChangeJourneySelection | null) => void;
	};

	let {
		journeys,
		filter,
		selectedJourneyId = null,
		now,
		onFilter,
		onSelect,
	}: Props = $props();

	const visible = $derived(filterChangeJourneys(journeys, filter).slice(0, 12));
	const counts = $derived(
		Object.fromEntries(
			CHANGE_JOURNEY_FILTERS.map((item) => [item.value, filterChangeJourneys(journeys, item.value).length]),
		) as Record<ChangeJourneyFilter, number>,
	);

	function statusClass(status: ChangeJourneyStatus): string {
		switch (status) {
			case "failed":
				return "border-destructive/60 bg-destructive/5 text-destructive";
			case "active":
				return "border-sky-500/60 bg-sky-500/5 text-sky-700 dark:text-sky-300";
			case "waiting":
				return "border-amber-400/70 bg-amber-500/5 text-amber-700 dark:text-amber-300";
			case "done":
				return "border-emerald-500/50 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300";
			default:
				return "border-border bg-card text-muted-foreground";
		}
	}

	function dotClass(state: ChangeJourneyStepState): string {
		switch (state) {
			case "failed":
				return "bg-destructive";
			case "active":
				return "bg-sky-500";
			case "waiting":
				return "bg-amber-500";
			case "done":
				return "bg-emerald-500";
			default:
				return "bg-muted-foreground/40";
		}
	}

	function repoLabel(journey: ChangeJourney): string {
		if (journey.repoLabel === "workflow-builder") return "workflow-builder";
		return journey.repoLabel;
	}

	function serviceLabel(journey: ChangeJourney): string {
		if (journey.services.length === 0) return "no service";
		if (journey.services.length === 1) return journey.services[0]!;
		return `${journey.services.length} services`;
	}

	function selectJourney(journey: ChangeJourney, selection = journey.primarySelection) {
		onSelect(selectedJourneyId === journey.id ? null : journey.id, selection);
	}
</script>

<section class="border-b bg-card/80 px-2 py-2">
	<div class="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
		<div class="flex items-center gap-1.5 text-[0.68rem] text-muted-foreground">
			<Route class="size-3.5" />
			<span class="font-medium text-foreground">Change Journey</span>
			<Badge variant="outline" class="h-4 px-1 text-[0.55rem]">{journeys.length}</Badge>
		</div>
		<div class="flex min-w-0 flex-wrap items-center gap-1">
			<Filter class="size-3 text-muted-foreground" />
			{#each CHANGE_JOURNEY_FILTERS as item (item.value)}
				{@const active = item.value === filter}
				<button
					type="button"
					class="inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[0.62rem] transition {active
						? 'border-primary/60 bg-primary/10 text-primary'
						: 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'}"
					onclick={() => onFilter(item.value)}
				>
					<span>{item.label}</span>
					{#if counts[item.value] > 0}
						<span class="rounded bg-muted px-1 font-mono text-[0.54rem] {active ? 'bg-background/70' : ''}">
							{counts[item.value]}
						</span>
					{/if}
				</button>
			{/each}
		</div>
	</div>

	{#if visible.length === 0}
		<div class="mx-1 rounded-md border border-dashed border-border/70 px-3 py-3 text-xs text-muted-foreground">
			No change journeys match this filter.
		</div>
	{:else}
		<div class="flex gap-2 overflow-x-auto px-1 pb-1">
			{#each visible as journey (journey.id)}
				{@const selected = selectedJourneyId === journey.id}
				<article
					class="w-[292px] shrink-0 rounded-md border bg-background p-2 shadow-sm transition hover:border-primary/40 hover:shadow-md {selected ? 'border-primary/70 ring-2 ring-primary/30' : 'border-border/80'}"
				>
					<button
						type="button"
						class="block w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
						aria-pressed={selected}
						onclick={() => selectJourney(journey)}
					>
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<div class="flex min-w-0 items-center gap-1.5">
									<span
										class="inline-flex size-2 shrink-0 rounded-full {journey.status === 'active'
											? 'animate-pulse'
											: ''} {dotClass(journey.status === 'neutral' ? 'skipped' : journey.status)}"
									></span>
									<h2 class="truncate text-xs font-semibold" title={journey.title}>{journey.title}</h2>
								</div>
								<div class="mt-0.5 truncate text-[0.62rem] text-muted-foreground" title={journey.subtitle ?? undefined}>
									{journey.subtitle ?? serviceLabel(journey)}
								</div>
							</div>
							<Badge variant="outline" class="h-5 shrink-0 px-1.5 text-[0.56rem] {statusClass(journey.status)}">
								{journey.status}
							</Badge>
						</div>
					</button>

					<div class="mt-2 flex flex-wrap items-center gap-1">
						<span class="inline-flex max-w-36 items-center gap-1 rounded border border-border/70 bg-muted/40 px-1.5 py-px text-[0.58rem] text-muted-foreground">
							<GitBranch class="size-2.5 shrink-0" />
							<span class="truncate">{repoLabel(journey)}</span>
						</span>
						{#if journey.pullRequestNumber}
							<span class="inline-flex items-center gap-1 rounded border border-border/70 bg-muted/40 px-1.5 py-px text-[0.58rem] text-muted-foreground">
								<GitPullRequestArrow class="size-2.5" />#{journey.pullRequestNumber}
							</span>
						{/if}
						{#if journey.sourceCommitSha}
							<span class="rounded border border-border/70 bg-muted/40 px-1.5 py-px font-mono text-[0.58rem] text-muted-foreground">
								{shortSha(journey.sourceCommitSha)}
							</span>
						{/if}
						{#each journey.environments as env (env)}
							<span class="rounded border border-border/70 bg-muted/40 px-1.5 py-px text-[0.58rem] text-muted-foreground">{env}</span>
						{/each}
					</div>

					<div class="mt-2 flex flex-wrap gap-1">
						{#each journey.services.slice(0, 4) as service (service)}
							<span class="inline-flex max-w-32 items-center gap-1 rounded bg-muted/50 px-1.5 py-px text-[0.58rem]">
								<Package class="size-2.5 shrink-0 text-muted-foreground" />
								<span class="truncate">{service}</span>
							</span>
						{/each}
						{#if journey.services.length > 4}
							<span class="rounded bg-muted/50 px-1.5 py-px text-[0.58rem] text-muted-foreground">
								+{journey.services.length - 4}
							</span>
						{/if}
					</div>

					<div class="mt-2 border-t border-border/60 pt-2">
						<div class="mb-1 flex items-center justify-between gap-2">
							<span class="truncate text-[0.62rem] font-medium text-foreground">{journey.currentPhase}</span>
							{#if journey.updatedAt}
								<span class="inline-flex shrink-0 items-center gap-1 font-mono text-[0.56rem] text-muted-foreground">
									<Clock3 class="size-2.5" />{relativeTime(journey.updatedAt, now)}
								</span>
							{/if}
						</div>
						<div class="space-y-1">
							{#each journey.steps.slice(0, 6) as step (step.id)}
								<div class="flex min-w-0 items-center gap-1.5 text-[0.62rem]">
									<span class="size-1.5 shrink-0 rounded-full {step.state === 'active' ? 'animate-pulse' : ''} {dotClass(step.state)}"></span>
									<button
										type="button"
										class="min-w-0 flex-1 truncate text-left text-muted-foreground hover:text-foreground"
										title={step.detail ?? step.label}
										onclick={() => selectJourney(journey, step.selection ?? journey.primarySelection)}
									>
										{step.label}{step.detail ? ` · ${step.kind === "deploy" ? shortTag(step.detail) : step.detail}` : ""}
									</button>
									{#if step.href && step.hrefLabel}
										<a
											href={step.href}
											target="_blank"
											rel="noreferrer"
											class="inline-flex shrink-0 items-center gap-0.5 text-[0.56rem] text-primary hover:underline"
										>
											{step.hrefLabel}<ExternalLink class="size-2.5" />
										</a>
									{/if}
								</div>
							{/each}
							{#if journey.steps.length > 6}
								<div class="text-[0.58rem] text-muted-foreground">+{journey.steps.length - 6} more evidence steps</div>
							{/if}
						</div>
					</div>

					{#if journey.hasFailure || journey.isWaiting}
						<div class="mt-2 flex items-center gap-1 text-[0.6rem] {journey.hasFailure ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'}">
							{#if journey.hasFailure}
								<AlertTriangle class="size-3" /> attention required
							{:else}
								<Radio class="size-3 animate-pulse" /> waiting for the next GitOps step
							{/if}
						</div>
					{/if}
				</article>
			{/each}
		</div>
	{/if}
</section>

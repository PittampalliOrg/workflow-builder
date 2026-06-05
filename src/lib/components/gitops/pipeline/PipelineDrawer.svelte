<script lang="ts">
	import {
		Anchor,
		Boxes,
		ChevronDown,
		ChevronRight,
		Container,
		ExternalLink,
		GitBranch,
		GitPullRequestArrow,
		Radio,
		TimerReset,
		Warehouse,
	} from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import {
		Collapsible,
		CollapsibleContent,
		CollapsibleTrigger,
	} from "$lib/components/ui/collapsible";
	import { Sheet, SheetContent, SheetHeader, SheetTitle } from "$lib/components/ui/sheet";
	import JsonViewer from "$lib/components/workflow/execution/json-viewer.svelte";
	import { eventsForSelection } from "$lib/gitops/activity-overlay";
	import { activityEventTone, toneClasses } from "$lib/gitops/activity-tone";
	import { buildVisual, healthVisual, promotionVisual } from "$lib/gitops/kargo-status";
	import type { PipelineModel } from "$lib/gitops/pipeline-types";
	import type { PipelineSelection } from "$lib/components/gitops/pipeline/PipelineGraph.svelte";
	import type { GitOpsActivityEvent } from "$lib/types/gitops-activity";
	import {
		formatAbsoluteTime,
		formatDurationMs,
		relativeTime,
		shortDigest,
		shortSha,
		shortTag,
		tektonPipelineRunUrl,
	} from "$lib/utils/gitops-display";

	type Props = {
		model: PipelineModel;
		selection: PipelineSelection;
		freightId?: string | null;
		events?: GitOpsActivityEvent[];
		now?: number;
		links?: {
			argoCdBase?: string;
			ghcrOrg?: string;
			stacksRepo?: string;
			workflowBuilderRepo?: string;
			tektonBase?: string | null;
		};
		onClose: () => void;
	};
	let {
		model,
		selection,
		freightId = null,
		events = [],
		now = Date.now(),
		links = {},
		onClose,
	}: Props = $props();

	let selectedEventId = $state<string | null>(null);
	let rawOpen = $state(false);

	// Reset event focus + raw inspector whenever the selection changes.
	$effect(() => {
		void selection?.id;
		selectedEventId = null;
		rawOpen = false;
	});

	const stage = $derived(
		selection?.kind === "stage"
			? (model.stages.find((s) => `stage/${s.name}` === selection.id) ?? null)
			: null,
	);
	const warehouse = $derived(
		selection?.kind === "warehouse"
			? (model.warehouses.find((w) => `warehouse/${w.name}` === selection.id) ?? null)
			: stage
				? (model.warehouses.find((w) => w.name === stage.warehouse) ?? null)
				: null,
	);
	const freight = $derived(
		freightId
			? (model.freights.find((f) => f.id === freightId) ?? null)
			: warehouse
				? (model.freights.find((f) => f.warehouse === warehouse.name) ?? null)
				: null,
	);
	// Env stages of the selected warehouse (shown when a warehouse / collapsed lane is selected).
	const warehouseStages = $derived(
		warehouse && !stage ? model.stages.filter((s) => s.warehouse === warehouse.name) : [],
	);

	const open = $derived(Boolean(selection) || Boolean(freightId));

	const title = $derived(
		stage
			? `${stage.warehouse} · ${stage.env}`
			: warehouse
				? warehouse.name
				: freight
					? freight.alias
					: "Details",
	);

	// Identity colour for the warehouse this selection maps to (header tint + spine).
	const identityColor = $derived(warehouse?.color ?? null);

	const ghcrOrg = $derived(links.ghcrOrg ?? "https://github.com/orgs/PittampalliOrg/packages/container/package");
	const argoBase = $derived((links.argoCdBase ?? "").replace(/\/+$/, ""));

	// argocd-agent mirrors each spoke's apps into a hub namespace named after the
	// agent (ryzen / dev / staging), e.g. ryzen/ryzen-workflow-builder.
	function argoUrl(env: string, name: string): string | null {
		if (!argoBase || name === "release-pins") return null;
		return `${argoBase}/applications/${env}/${env}-${name}`;
	}
	const stageArgoUrl = $derived(stage && !stage.dormant ? argoUrl(stage.env, stage.warehouse) : null);
	// Promoter CommitStatus phase → tone (pending soak amber, success green, failure red).
	function gatePhaseColor(phase: string | null): string {
		if (phase === "success") return "text-emerald-600 dark:text-emerald-400";
		if (phase === "failure") return "text-red-600 dark:text-red-400";
		if (phase === "pending") return "text-amber-600 dark:text-amber-400";
		return "text-muted-foreground";
	}

	// The warehouse / package name the selection maps to (for GHCR + deep links).
	const targetName = $derived(stage?.warehouse ?? warehouse?.name ?? null);
	const isReleasePins = $derived(targetName === "release-pins");

	// Event history for the selected stage / warehouse. Sharing
	// `eventsForSelection` with the overlay's `targetForEvent` keeps the drawer
	// history in lock-step with the node activity chip.
	const nodeEvents = $derived(
		selection?.kind === "stage" || selection?.kind === "warehouse"
			? eventsForSelection(events, selection, model).slice(0, 25)
			: ([] as GitOpsActivityEvent[]),
	);
	const activeEvent = $derived(
		nodeEvents.find((e) => e.eventId === selectedEventId) ?? nodeEvents[0] ?? null,
	);
	const activeCorrelation = $derived(
		activeEvent
			? Object.entries(activeEvent.correlation).sort(([a], [b]) => a.localeCompare(b))
			: [],
	);
	// True when any correlated event is "live" (fresh, non-terminal) — drives the
	// pulsing live indicator in the feed header. Shared tone language (one source
	// of truth in `activity-tone.ts`).
	const hasLive = $derived(nodeEvents.some((e) => activityEventTone(e, now) === "active"));

	const tektonBase = $derived((links.tektonBase ?? "").replace(/\/+$/, ""));

	// Provenance of this stage's health/sync/image. dev/staging come from the hub
	// inventory snapshot (the viewing cluster can't query other clusters' live
	// state); "pinned" means we only know the git pin, not reconciled cluster state.
	function sourceLabel(source: string): string {
		if (source === "pin-only") return "pinned · no reconciled cluster data";
		if (source === "live-only") return "live pod · no hub inventory";
		return "hub inventory";
	}

	// ── Delivery timeline (Commit → Build → Pin → Promote → Deploy) ────────────
	// Assembled entirely from the selected stage's inventory-sourced fields +
	// provenance — correlates the image build to its commit, pin, and promotion.
	type DeliveryState = "done" | "active" | "failed" | "pending" | "skipped";
	type DeliveryStep = {
		key: string;
		label: string;
		state: DeliveryState;
		detail: string | null;
		sub?: string | null;
		/** Epoch ms anchor for inter-step gap + lead-time math (null = no timestamp). */
		at: number | null;
		/** Gap to the next step, e.g. "+1m 10s" — computed after the steps are built. */
		gap?: string | null;
		/** Deploy only: a single "live since" relative time (the chain's one absolute clock). */
		liveAgo?: string | null;
		liveTitle?: string | null;
		href?: string | null;
		hrefLabel?: string | null;
	};

	function epochMs(s: string | null | undefined): number | null {
		if (!s) return null;
		const t = Date.parse(s);
		return Number.isFinite(t) ? t : null;
	}
	/** Inter-step gap label. Sub-second collapses to "+0s" (a fast automated burst). */
	function formatGap(deltaMs: number | null): string | null {
		if (deltaMs == null) return null;
		if (deltaMs < 1000) return "+0s";
		return `+${formatDurationMs(deltaMs)}`;
	}

	const wbRepo = $derived(
		(links.workflowBuilderRepo ?? "https://github.com/PittampalliOrg/workflow-builder").replace(/\/+$/, ""),
	);
	const stacksRepoBase = $derived(
		(links.stacksRepo ?? "https://github.com/PittampalliOrg/stacks").replace(/\/+$/, ""),
	);

	function dotClass(state: DeliveryState): string {
		switch (state) {
			case "done":
				return "bg-emerald-500";
			case "active":
				return "bg-sky-500";
			case "failed":
				return "bg-red-500";
			case "pending":
				return "bg-amber-500";
			default:
				return "bg-muted-foreground/40";
		}
	}

	// The timeline shows DURATIONS, not a repeated "N mins ago" — the automated
	// outer-loop runs commit→pin in one sub-minute burst, so absolute per-row times
	// collapse to one value. Instead: inter-step gaps on the connectors, phase
	// durations inline (build, soak), a commit→live lead-time header, and a single
	// "live since" on Deploy. (NB: provenance.committedAt is the pin-commit time, so
	// the lead-time anchors on build.startedAt — the genuinely-earliest real event.)
	const delivery = $derived.by<{ steps: DeliveryStep[]; lead: string | null }>(() => {
		if (!stage) return { steps: [], lead: null };
		const steps: DeliveryStep[] = [];
		const prov = stage.provenance;

		// Commit — the source commit that produced the image.
		const commitSha = prov?.commitSha ?? stage.commitSha ?? null;
		steps.push({
			key: "commit",
			label: "Commit",
			state: commitSha ? "done" : "pending",
			detail: commitSha ? shortSha(commitSha) : "—",
			sub: prov?.commitMessage ?? null,
			at: epochMs(prov?.committedAt),
			href: commitSha ? `${wbRepo}/commit/${commitSha}` : null,
			hrefLabel: "source",
		});

		// Build — the Tekton outer-loop run (dev lane). Duration is the signal here;
		// ryzen runs the same image via commit-pin and carries no Tekton build record.
		const b = stage.build;
		if (b) {
			const started = b.startedAt ? Date.parse(b.startedAt) : Number.NaN;
			const elapsed =
				b.durationMs ?? (Number.isFinite(started) ? Math.max(0, now - started) : null);
			const phaseLabel = b.phase === "building" ? "building" : b.phase === "failed" ? "failed" : "built";
			// Sequence on finishedAt once terminal (the build hands off to pin/promote);
			// while building, on startedAt.
			steps.push({
				key: "build",
				label: "Build",
				state: b.phase === "built" ? "done" : b.phase === "failed" ? "failed" : "active",
				detail: [phaseLabel, elapsed != null ? formatDurationMs(elapsed) : null].filter(Boolean).join(" · ") || null,
				sub: b.pipelineRun,
				at: b.phase === "building" ? epochMs(b.startedAt) : epochMs(b.finishedAt ?? b.startedAt),
				href: tektonPipelineRunUrl(tektonBase, b.pipelineRun),
				hrefLabel: "Tekton",
			});
		} else {
			steps.push({
				key: "build",
				label: "Build",
				state: "skipped",
				at: null,
				detail:
					stage.deliveryMode === "direct-main"
						? "commit-pin lane · no Tekton build"
						: "no build record",
			});
		}

		// Pin — the stacks release-pins commit that pinned this image.
		const pin = prov?.pinCommit ?? null;
		steps.push({
			key: "pin",
			label: "Pin",
			state: pin ? "done" : "pending",
			detail: pin ? shortSha(pin) : "—",
			at: epochMs(prov?.pinCommittedAt),
			href: pin ? `${stacksRepoBase}/commit/${pin}` : null,
			hrefLabel: "release-pins",
		});

		// Promote — Promoter-gated (dev) vs direct-main (ryzen) vs dormant (staging).
		if (stage.deliveryMode === "promoter") {
			const p = stage.promotion;
			if (p?.inFlight) {
				steps.push({
					key: "promote",
					label: "Promote",
					state: "active",
					detail: `→ ${p.proposedTag ? shortSha(p.proposedTag) : "next"}${p.soak ? ` · soak ${p.soak.label}` : ""}`,
					sub: p.stalledOn ? `waiting: ${p.stalledOn}` : null,
					at: null, // in progress — no settled timestamp yet
					href: p.pullRequest?.url ?? null,
					hrefLabel: p.pullRequest?.url ? "PR" : null,
				});
			} else if (p) {
				steps.push({
					key: "promote",
					label: "Promote",
					state: "done",
					detail: `promoted${p.activeTag ? ` · ${shortSha(p.activeTag)}` : ""}${p.soak?.total ? ` · soak ${p.soak.total}` : ""}`,
					at: epochMs(p.activeAt),
					href: p.pullRequest?.url ?? null,
					hrefLabel: p.pullRequest?.url ? "PR" : null,
				});
			} else {
				steps.push({ key: "promote", label: "Promote", state: "pending", at: null, detail: "awaiting promotion" });
			}
		} else if (stage.deliveryMode === "direct-main") {
			steps.push({
				key: "promote",
				label: "Promote",
				state: "done",
				at: null, // not a distinct event — the pin IS the promotion on direct-main
				detail: "direct to main · no Promoter gate",
			});
		} else {
			steps.push({ key: "promote", label: "Promote", state: "skipped", at: null, detail: "dormant lane" });
		}

		// Deploy — ArgoCD sync/health on the target cluster. Carries the chain's one
		// absolute "live since" clock.
		const deployState: DeliveryState = stage.dormant
			? "skipped"
			: stage.health === "Healthy"
				? "done"
				: stage.health === "Degraded"
					? "failed"
					: stage.health === "Progressing"
						? "active"
						: "pending";
		steps.push({
			key: "deploy",
			label: "Deploy",
			state: deployState,
			detail: [stage.syncStatus, stage.health].filter(Boolean).join(" · ") || (stage.dormant ? "dormant" : "—"),
			sub: stage.drift ? `drift: ${stage.drift}` : null,
			at: epochMs(stage.updatedAt),
			liveAgo: stage.updatedAt && !stage.dormant ? relativeTime(stage.updatedAt, now) : null,
			liveTitle: stage.updatedAt ? formatAbsoluteTime(stage.updatedAt, now) : null,
			href: stageArgoUrl,
			hrefLabel: stageArgoUrl ? "ArgoCD" : null,
		});

		// Inter-step gaps (only between adjacent steps that both have a timestamp —
		// null-anchored steps like ryzen's direct-main Promote simply break the chain).
		for (let i = 0; i < steps.length - 1; i++) {
			const a = steps[i].at;
			const c = steps[i + 1].at;
			if (a != null && c != null) steps[i].gap = formatGap(Math.max(0, c - a));
		}

		// Lead time: from the genuinely-earliest real event (build start, else commit)
		// to the live deploy. Build duration lives "inside" this, so anchoring on
		// build.startedAt captures it (committedAt would understate it).
		const buildStart = epochMs(stage.build?.startedAt ?? null);
		const anchors = steps.map((s) => s.at).filter((x): x is number => x != null);
		const starts = [buildStart, ...anchors].filter((x): x is number => x != null);
		const startAt = starts.length ? Math.min(...starts) : null;
		const endAt = epochMs(stage.updatedAt);
		const lead =
			startAt != null && endAt != null && endAt > startAt ? formatDurationMs(endAt - startAt) : null;

		return { steps, lead };
	});
</script>

{#snippet sectionLabel(text: string)}
	<span class="text-[0.58rem] font-medium uppercase tracking-wider text-muted-foreground">{text}</span>
{/snippet}

{#snippet detailRow(label: string, value: string, mono = false)}
	<div class="flex items-center justify-between gap-3 py-0.5">
		<dt class="shrink-0 text-[0.7rem] text-muted-foreground">{label}</dt>
		{#if mono}
			<dd class="min-w-0 truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[0.68rem]" title={value}>
				{value}
			</dd>
		{:else}
			<dd class="min-w-0 truncate text-right text-xs" title={value}>{value}</dd>
		{/if}
	</div>
{/snippet}

<Sheet {open} onOpenChange={(v) => (!v ? onClose() : undefined)}>
	<SheetContent side="right" class="w-[440px] overflow-y-auto sm:max-w-[440px]">
		<!-- Header: identity icon + title; identity spine + subtle tint -->
		<SheetHeader
			class="space-y-0 border-l-[3px] pl-4 pr-5"
			style={identityColor ? `border-color:${identityColor};background:${identityColor}0f` : ""}
		>
			<SheetTitle class="flex items-center gap-2 text-[0.8rem] font-semibold">
				{#if warehouse?.kind === "bundle"}
					<Boxes class="size-4 shrink-0" style={identityColor ? `color:${identityColor}` : ""} />
				{:else}
					<Warehouse class="size-4 shrink-0" style={identityColor ? `color:${identityColor}` : ""} />
				{/if}
				<span class="truncate">{title}</span>
			</SheetTitle>
			<div class="flex flex-wrap items-center gap-1.5 pt-1">
				{#if stage}
					{@const headerHealth = healthVisual(stage.health)}
					{@const HeaderIcon = headerHealth.icon}
					<Badge variant="outline" class="h-5 gap-1 px-1.5 text-[0.6rem]" style={`color:${headerHealth.color}`}>
						{#if HeaderIcon}<HeaderIcon class={headerHealth.spin ? "size-3 animate-spin" : "size-3"} />{/if}
						{headerHealth.label}
					</Badge>
					<Badge variant="secondary" class="h-5 px-1.5 text-[0.6rem]">{stage.env}</Badge>
					{#if stage.dormant}
						<Badge variant="outline" class="h-5 border-dashed px-1.5 text-[0.6rem]">dormant</Badge>
					{/if}
				{:else if warehouse}
					<Badge variant="secondary" class="h-5 px-1.5 text-[0.6rem]">{warehouse.subsystem}</Badge>
					<Badge variant="outline" class="h-5 px-1.5 text-[0.6rem]">{warehouse.kind}</Badge>
				{/if}
			</div>
		</SheetHeader>

		<div class="mt-2 space-y-5 px-5 pb-8 text-xs">
			<!-- Recent events: first-class live activity feed, sitting near the top. -->
			{#if stage || warehouse}
				<section class="space-y-2.5 border-t border-border/60 pt-5 first:border-t-0 first:pt-0">
					<div class="flex items-center justify-between">
						{@render sectionLabel("Recent events")}
						{#if hasLive}
							<span class="flex items-center gap-1 text-[0.58rem] font-medium uppercase tracking-wider text-sky-600 dark:text-sky-400">
								<span class="relative flex size-1.5">
									<span class="absolute inline-flex size-full animate-ping rounded-full bg-sky-500/70"></span>
									<span class="relative inline-flex size-1.5 rounded-full bg-sky-500"></span>
								</span>
								live
							</span>
						{/if}
					</div>
					{#if nodeEvents.length === 0}
						<div class="rounded-md border border-dashed border-border/70 px-3 py-2.5 text-[0.66rem] text-muted-foreground">
							Waiting for events…
						</div>
					{:else}
						<div class="max-h-64 space-y-1.5 overflow-y-auto pb-1 pr-1">
							{#each nodeEvents as event (event.eventId)}
								{@const tone = activityEventTone(event, now)}
								{@const tc = toneClasses(tone)}
								<button
									type="button"
									class="w-full rounded-md border border-border/70 border-l-2 px-2.5 py-2 text-left shadow-sm transition hover:bg-muted/40 hover:shadow-md {tc.border} {event.eventId ===
									activeEvent?.eventId
										? 'ring-2 ring-primary/40'
										: ''}"
									onclick={() => (selectedEventId = event.eventId)}
								>
									<div class="flex items-center justify-between gap-2">
										<span class="flex min-w-0 items-center gap-1.5 text-[0.72rem] font-semibold {tc.text}">
											<Radio class="size-3 shrink-0 {tone === 'active' ? 'animate-pulse' : ''}" />
											<span class="truncate">
												{event.phase ?? "event"}{event.reason ? ` · ${event.reason}` : ""}
											</span>
										</span>
										<span
											class="shrink-0 font-mono text-[0.58rem] text-muted-foreground"
											title={formatAbsoluteTime(event.observedAt, now)}
										>
											{relativeTime(event.observedAt, now)}
										</span>
									</div>
									<div class="mt-0.5 truncate text-[0.62rem] text-muted-foreground" title={event.activityType}>
										{event.activityType}
									</div>
									{#if event.message}
										<div class="truncate text-[0.62rem] text-muted-foreground" title={event.message}>
											{event.message}
										</div>
									{/if}
								</button>
							{/each}
						</div>
					{/if}
				</section>
			{/if}

			{#if stage}
				{@const health = healthVisual(stage.health)}
				{@const promo = promotionVisual(stage.promotionPhase)}
				{@const Icon = health.icon}
				<!-- Operational + inventory detail -->
				<section class="space-y-2.5 border-t border-border/60 pt-5 first:border-t-0 first:pt-0">
					{@render sectionLabel("Status")}
					<div class="flex items-center gap-2 text-[0.8rem] font-semibold" style={`color:${health.color}`}>
						{#if Icon}<Icon class={health.spin ? "size-4 animate-spin" : "size-4"} />{/if}
						{health.label}
					</div>

					<dl class="space-y-0.5">
						{@render detailRow("Environment", stage.env)}
						{#if stage.source}{@render detailRow("Data source", sourceLabel(stage.source))}{/if}
						{#if stage.syncStatus}{@render detailRow("Sync", stage.syncStatus)}{/if}
						{#if stage.desiredTag}{@render detailRow("Desired", stage.desiredTag, true)}{/if}
						{#if stage.liveTag}{@render detailRow("Live", stage.liveTag, true)}{/if}
						{#if stage.drift}{@render detailRow("Drift", stage.drift)}{/if}
						{#if promo}{@render detailRow("Promotion", promo.label)}{/if}
						{#if stage.gate}
							{@render detailRow("Gate", `${stage.gate.label}${stage.gate.phase ? ` · ${stage.gate.phase}` : ""}`)}
						{/if}
						{#if stage.promoterBranch}{@render detailRow("Branch", stage.promoterBranch, true)}{/if}
						{#if stage.promoterHydratedSha}{@render detailRow("Hydrated", shortSha(stage.promoterHydratedSha), true)}{/if}
						{#if stage.updatedAt}{@render detailRow("Updated", relativeTime(stage.updatedAt, now))}{/if}
					</dl>

					<!-- Promoter-aware promotion detail (C2): proposed-vs-active hydrated
					     shas, the gates the next freight must clear, soak countdown, and
					     the promotion PR. Present only on Promoter-gated stages (dev). -->
					{#if stage.promotion}
						{@const p = stage.promotion}
						<div
							class="space-y-2 rounded-md border border-border/70 p-2.5 shadow-sm {p.inFlight
								? 'border-amber-400/60 bg-amber-50/50 dark:bg-amber-950/20'
								: ''}"
						>
							<div class="flex items-center justify-between">
								<span class="flex items-center gap-1.5 text-[0.7rem] font-semibold">
									<GitPullRequestArrow class="size-3.5" />
									{p.inFlight ? "Promotion in flight" : "Promotion"}
								</span>
								{#if p.pullRequest?.url}
									<a
										href={p.pullRequest.url}
										target="_blank"
										rel="noreferrer"
										class="inline-flex items-center gap-1 text-[0.7rem] text-primary hover:underline"
									>
										PR{p.pullRequest.state ? ` · ${p.pullRequest.state}` : ""}
										<ExternalLink class="size-3" />
									</a>
								{/if}
							</div>

							<div class="grid grid-cols-2 gap-2">
								<div class="space-y-0.5">
									{@render sectionLabel("Live")}
									<div class="font-mono text-[0.68rem]" title={p.activeTag ?? ""}>
										{p.activeTag ? shortSha(p.activeTag) : "—"}
									</div>
								</div>
								<div class="space-y-0.5">
									{@render sectionLabel("Next")}
									<div
										class="font-mono text-[0.68rem] {p.inFlight ? 'text-amber-700 dark:text-amber-300' : ''}"
										title={p.proposedTag ?? ""}
									>
										{p.proposedTag ? shortSha(p.proposedTag) : "—"}
									</div>
								</div>
							</div>

							{#if p.soak}
								<div class="flex items-center gap-1 text-[0.66rem] text-muted-foreground">
									<TimerReset class="size-3 shrink-0" />soak {p.soak.label}
								</div>
							{/if}

							{#if p.gates.length > 0}
								<div class="space-y-1 border-t border-border/70 pt-2">
									{#each p.gates as gate (gate.key)}
										<div class="flex items-center justify-between gap-2 text-[0.66rem]">
											<span
												class="truncate {gate.key === p.stalledOn
													? 'font-medium text-amber-700 dark:text-amber-300'
													: 'text-muted-foreground'}"
												title={gate.description ?? gate.key}
											>
												{gate.key}
											</span>
											<span class="shrink-0 font-mono text-[0.6rem] {gatePhaseColor(gate.phase)}">
												{gate.phase ?? "—"}
											</span>
										</div>
									{/each}
								</div>
							{/if}
						</div>
					{:else if stage.awaitingReconcile}
						<div class="rounded-md border border-dashed border-border/70 px-3 py-2.5 text-[0.66rem] text-muted-foreground">
							Pinned / sourced but no reconciled inventory evidence yet — awaiting reconcile.
						</div>
					{/if}

					{#if stage.rollup}
						<div class="flex flex-wrap gap-1.5">
							<Badge variant="secondary" class="h-5 px-1.5 text-[0.6rem]">{stage.rollup.synced} synced</Badge>
							{#if stage.rollup.drift > 0}<Badge variant="outline" class="h-5 border-amber-400 px-1.5 text-[0.6rem] text-amber-700 dark:text-amber-300">{stage.rollup.drift} drift</Badge>{/if}
							{#if stage.rollup.degraded > 0}<Badge variant="destructive" class="h-5 px-1.5 text-[0.6rem]">{stage.rollup.degraded} degraded</Badge>{/if}
							<Badge variant="outline" class="h-5 px-1.5 text-[0.6rem]">{stage.rollup.total} total</Badge>
						</div>
					{/if}

					{#if stageArgoUrl || (targetName && !isReleasePins) || tektonBase}
						<div class="flex flex-wrap items-center gap-2 pt-0.5">
							{#if stageArgoUrl}
								<a class="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 text-[0.68rem] text-primary transition hover:bg-muted" href={stageArgoUrl} target="_blank" rel="noreferrer">
									ArgoCD <ExternalLink class="size-3" />
								</a>
							{/if}
							{#if targetName && !isReleasePins}
								<a class="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 text-[0.68rem] text-primary transition hover:bg-muted" href={`${ghcrOrg}/${targetName}`} target="_blank" rel="noreferrer">
									GHCR <ExternalLink class="size-3" />
								</a>
							{/if}
							{#if tektonBase}
								<a class="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 text-[0.68rem] text-primary transition hover:bg-muted" href={tektonBase} target="_blank" rel="noreferrer">
									Tekton <ExternalLink class="size-3" />
								</a>
							{/if}
						</div>
					{/if}
				</section>

				<!-- Delivery timeline: Commit → Build → Pin → Promote → Deploy. Shows
				     inter-step gaps + phase durations + a commit→live lead time (a
				     repeated "N mins ago" would collapse — the outer-loop is one burst). -->
				<section class="space-y-2.5 border-t border-border/60 pt-5">
					<div class="flex items-center justify-between gap-2">
						{@render sectionLabel("Delivery")}
						{#if delivery.lead}
							<span
								class="shrink-0 font-mono text-[0.58rem] text-muted-foreground"
								title="Lead time from build start to live deploy"
							>
								commit→live <span class="text-foreground">{delivery.lead}</span>
							</span>
						{/if}
					</div>
					<ol class="space-y-0">
						{#each delivery.steps as step, i (step.key)}
							{@const last = i === delivery.steps.length - 1}
							<li class="flex gap-2.5">
								<div class="flex flex-col items-center pt-0.5">
									<span class="relative flex size-2.5 shrink-0 items-center justify-center">
										{#if step.state === "active"}
											<span class="absolute inline-flex size-full animate-ping rounded-full {dotClass(step.state)} opacity-60"></span>
										{/if}
										<span class="relative inline-flex size-2 rounded-full {dotClass(step.state)}"></span>
									</span>
									{#if !last}
										<span class="mt-0.5 w-px flex-1 bg-border/70"></span>
									{/if}
								</div>
								<div class="min-w-0 flex-1 {last ? '' : 'pb-3'}">
									<div class="flex items-center justify-between gap-2">
										<span class="flex items-center gap-1.5 text-[0.72rem] font-semibold">
											{step.label}
											{#if step.href && step.hrefLabel}
												<a
													href={step.href}
													target="_blank"
													rel="noreferrer"
													class="inline-flex items-center gap-0.5 text-[0.62rem] font-normal text-primary hover:underline"
												>
													{step.hrefLabel}<ExternalLink class="size-2.5" />
												</a>
											{/if}
										</span>
										{#if step.liveAgo}
											<span class="shrink-0 font-mono text-[0.58rem] text-muted-foreground" title={step.liveTitle ?? undefined}>
												live {step.liveAgo}
											</span>
										{/if}
									</div>
									{#if step.detail}
										<div class="truncate font-mono text-[0.64rem] text-muted-foreground" title={step.detail}>
											{step.detail}
										</div>
									{/if}
									{#if step.sub}
										<div class="truncate text-[0.62rem] text-muted-foreground/80" title={step.sub}>
											{step.sub}
										</div>
									{/if}
									{#if step.gap}
										<div class="mt-1 font-mono text-[0.56rem] text-muted-foreground/70" title="Time until the next step">
											↓ {step.gap}
										</div>
									{/if}
								</div>
							</li>
						{/each}
					</ol>
				</section>
			{/if}

			{#if warehouse}
				<section class="space-y-2.5 border-t border-border/60 pt-5 first:border-t-0 first:pt-0">
					<div class="flex items-center justify-between">
						{@render sectionLabel("Warehouse")}
						<Badge variant="outline" class="h-5 px-1.5 text-[0.6rem]">{warehouse.subsystem}</Badge>
					</div>
					<div class="space-y-1">
						{#each warehouse.subscriptions as sub (sub.id)}
							<div class="flex items-center gap-1.5 truncate rounded bg-muted/60 px-1.5 py-0.5 font-mono text-[0.68rem] text-muted-foreground" title={sub.repoURL}>
								{#if sub.type === "git"}<GitBranch class="size-3 shrink-0" />{:else if sub.type === "chart"}<Anchor class="size-3 shrink-0" />{:else}<Container class="size-3 shrink-0" />{/if}
								{sub.repoURL}
							</div>
						{/each}
					</div>

					{#if warehouseStages.length > 0}
						<div class="space-y-1.5 pt-0.5">
							{@render sectionLabel("Stages")}
							{#each warehouseStages as st (st.name)}
								{@const v = healthVisual(st.health)}
								{@const Icon = v.icon}
								<div class="flex items-center gap-2 text-[0.7rem] {st.dormant ? 'opacity-60' : ''}">
									<span class="w-14 shrink-0 font-medium">{st.env}</span>
									<span class="flex items-center gap-1" style={`color:${v.color}`}>
										{#if Icon}<Icon class={v.spin ? "size-3 animate-spin" : "size-3"} />{/if}{v.label}
									</span>
									{#if st.desiredTag}
										<span class="ml-auto truncate font-mono text-[0.62rem] text-muted-foreground">{shortTag(st.desiredTag)}</span>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
					{#if warehouse.dependedOnBy?.length}
						<div class="space-y-0.5 text-[0.68rem] text-muted-foreground">
							{@render sectionLabel("Depended on by")}
							{#each warehouse.dependedOnBy as dep (dep)}<div>· {dep}</div>{/each}
						</div>
					{/if}
					{#if warehouse.dependsOn?.length}
						<div class="space-y-0.5 text-[0.68rem] text-muted-foreground">
							{@render sectionLabel("Depends on")}
							<div>{warehouse.dependsOn.join(", ")}</div>
						</div>
					{/if}
					{#if warehouse.kind === "service"}
						<a class="inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1 text-[0.68rem] text-primary transition hover:bg-muted" href={`${ghcrOrg}/${warehouse.name}`} target="_blank" rel="noreferrer">
							GHCR package <ExternalLink class="size-3" />
						</a>
					{/if}
				</section>
			{/if}

			{#if freight}
				<section class="space-y-2.5 border-t border-border/60 pt-5 first:border-t-0 first:pt-0">
					<div class="flex items-center justify-between">
						{@render sectionLabel("Freight")}
						<span class="truncate font-mono text-[0.68rem] text-muted-foreground">{freight.alias}</span>
					</div>
					<div class="space-y-1">
						{#each freight.artifacts as art (art.repoURL + art.kind)}
							{#if art.kind === "image"}
								<div class="flex items-center gap-1.5 text-[0.7rem]"><Container class="size-3 shrink-0 text-muted-foreground" /> <span class="truncate font-mono" title={art.tag ?? ""}>{art.tag ?? "image"}</span></div>
								{#if art.digest}<div class="truncate pl-4 font-mono text-[0.62rem] text-muted-foreground" title={art.digest}>{shortDigest(art.digest)}</div>{/if}
							{:else if art.kind === "git"}
								<div class="flex items-center gap-1.5 text-[0.7rem]"><GitBranch class="size-3 shrink-0 text-muted-foreground" /> <span class="truncate font-mono">{art.sha ? shortSha(art.sha) : "config"}</span></div>
								{#if art.message}<div class="pl-4 text-[0.62rem] text-muted-foreground">{art.message}</div>{/if}
							{/if}
						{/each}
					</div>
					{#if freight.createdAt}<div class="text-[0.66rem] text-muted-foreground">created {relativeTime(freight.createdAt, now)}</div>{/if}
				</section>
			{/if}

			<!-- Raw inspector: secondary, collapsed, near the bottom. -->
			{#if activeEvent}
				<div class="border-t border-border/60 pt-5">
				<Collapsible bind:open={rawOpen}>
					<CollapsibleTrigger>
						{#snippet child({ props })}
							<button
								{...props}
								class="inline-flex items-center gap-1 text-[0.66rem] font-medium uppercase tracking-wider text-muted-foreground transition hover:text-foreground"
							>
								{#if rawOpen}
									<ChevronDown class="size-3" />
								{:else}
									<ChevronRight class="size-3" />
								{/if}
								Raw inspector
							</button>
						{/snippet}
					</CollapsibleTrigger>
					<CollapsibleContent>
						<div class="mt-2.5 space-y-2">
							{#if activeCorrelation.length > 0}
								<dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border border-border/70 bg-muted/20 p-2.5">
									{#each activeCorrelation as [key, value] (key)}
										<dt class="font-mono text-[0.58rem] text-muted-foreground">{key}</dt>
										<dd class="truncate font-mono text-[0.62rem]" title={String(value)}>{String(value)}</dd>
									{/each}
								</dl>
							{/if}
							<JsonViewer data={activeEvent.raw} label="raw" collapsed />
						</div>
					</CollapsibleContent>
				</Collapsible>
				</div>
			{/if}
		</div>
	</SheetContent>
</Sheet>

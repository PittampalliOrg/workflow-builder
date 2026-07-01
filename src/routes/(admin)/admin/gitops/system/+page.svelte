<script lang="ts">
	import { onDestroy, onMount, setContext, untrack } from "svelte";
	import {
		AlertTriangle,
		CheckCircle2,
		ChevronsUpDown,
		Clock3,
		ExternalLink,
		GitBranch,
		Radio,
		RefreshCw,
		Route,
		X,
	} from "@lucide/svelte";

	import { goto } from "$app/navigation";
	import { page } from "$app/state";

	import { Button } from "$lib/components/ui/button";
	import PipelineGraph, {
		type PipelineSelection,
	} from "$lib/components/gitops/pipeline/PipelineGraph.svelte";
	import { PIPELINE_LINKS_CONTEXT } from "$lib/gitops/pipeline-layout";
	import { activityTargetKeys, applyPipelineActivityOverlay } from "$lib/gitops/activity-overlay";
	import {
		buildChangeJourneys,
		journeyGraphHighlight,
		type ChangeJourney,
		type ChangeJourneyStep,
	} from "$lib/gitops/change-journey";
	import { clearFlowing, markFlowing } from "$lib/gitops/gitops-flow.svelte";
	import { nowTick, startClock } from "$lib/gitops/gitops-tick.svelte";
	import {
		deriveStreamHealth,
		GITOPS_EVENT_REFRESH_DEBOUNCE_MS,
		gitOpsDeploymentMetadataUrl,
		isInventoryActivityEvent,
		mergeActivityEvents,
		shouldRefreshGitOpsMetadata,
	} from "$lib/gitops/event-driven-refresh";
	import { buildPipelineModel } from "$lib/gitops/pipeline-model";
	import type { PipelineModel, PipelineStage } from "$lib/gitops/pipeline-types";
	import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";
	import type { DeploymentMetadataResponse } from "$lib/types/deployment-metadata";
	import type {
		GitOpsActivityEvent,
		GitOpsActivityEventsResponse,
	} from "$lib/types/gitops-activity";
	import {
		formatAbsoluteTime,
		formatDurationMs,
		relativeTime,
		shortSha,
		shortTag,
		tektonPipelineRunUrl,
	} from "$lib/utils/gitops-display";

	import type { PageData } from "./$types";

	type Props = { data: PageData };
	let { data }: Props = $props();

	type EnvName = "dev" | "ryzen";
	type EnvStatus = "Healthy" | "Deploying" | "Degraded" | "Out-of-date";
	type EvidenceTarget =
		| { kind: "environment"; env: EnvName }
		| { kind: "change"; id: string }
		| null;
	type GraphHighlight = { warehouse: string; stageNames: string[] } | null;
	type EvidenceStep = {
		id: string;
		label: "Commit" | "Build" | "Pin" | "Promote" | "Deploy";
		state: ChangeJourneyStep["state"];
		at: string | null;
		detail: string | null;
		href: string | null;
		hrefLabel: string | null;
	};

	type EnvOverview = {
		env: EnvName;
		status: EnvStatus;
		reason: string;
		stage: PipelineStage | null;
		runningSha: string | null;
		runningAt: string | null;
		service: string;
		image: string;
		drifted: boolean;
		driftLabel: string | null;
		leadMs: number | null;
		capacity: string;
		capacityReady: number | null;
		capacityDesired: number | null;
		capacityRestarts: number | null;
		health: string;
		actionHref: string | null;
		inFlight: boolean;
	};

	let metadata = $state<DeploymentMetadataResponse>(untrack(() => data.initial));
	let promotions = $state<PromotionStrategiesResponse>(untrack(() => data.promotions));
	let activityEvents = $state<GitOpsActivityEvent[]>(
		untrack(() => (data.activityEvents ?? []).filter((e) => !isInventoryActivityEvent(e))),
	);
	let lastSeenSequence = untrack(() =>
		(data.activityEvents ?? []).reduce((max, e) => Math.max(max, e.sequence), 0),
	);
	let lastEventAt = $state<number | null>(
		untrack(() => {
			const newest = (data.activityEvents ?? [])[0];
			const parsed = newest ? Date.parse(newest.observedAt) : NaN;
			return Number.isNaN(parsed) ? null : parsed;
		}),
	);
	const links = untrack(() => data.links);
	setContext(PIPELINE_LINKS_CONTEXT, links);

	let loading = $state(false);
	let requestError = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;
	let clockStop: (() => void) | null = null;
	let eventRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	let activityEventSource: EventSource | null = null;
	let activityReconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let activityConnected = $state(false);
	let activityReconnecting = $state(false);
	let activityError = $state<string | null>(null);
	let eventBuffer: GitOpsActivityEvent[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let reconnectDelay = 3000;

	let showGraph = $state(false);
	let selection = $state<PipelineSelection>(null);
	let selectedJourneyId = $state<string | null>(null);
	let evidenceTarget = $state<EvidenceTarget>(null);

	const now = $derived(nowTick());
	const baseModel = $derived(buildPipelineModel(metadata, promotions));
	const model = $derived(applyPipelineActivityOverlay(baseModel, activityEvents));
	const changeJourneys = $derived(
		buildChangeJourneys({
			events: activityEvents,
			metadata,
			model: baseModel,
			links,
			viewerEmail: data.viewerEmail,
			limit: 12,
		}),
	);
	const selectedJourney = $derived(
		selectedJourneyId ? (changeJourneys.find((journey) => journey.id === selectedJourneyId) ?? null) : null,
	);
	const activeHighlight = $derived(
		selectedJourney ? (journeyGraphHighlight(selectedJourney) as GraphHighlight) : null,
	);
	const streamState = $derived(
		deriveStreamHealth({
			connected: activityConnected,
			reconnecting: activityReconnecting,
			lastEventAt,
			now,
		}),
	);
	const streamAge = $derived(lastEventAt !== null ? now - lastEventAt : null);
	const streamAgeLabel = $derived.by(() => compactAge(streamAge));
	const stacksShortSha = $derived(metadata.gitops.stacksMain?.shortSha ?? "unknown");
	const stacksUrl = $derived(metadata.gitops.stacksMain?.url ?? `${links.stacksRepo}/commits/main`);
	const inventoryAt = $derived(
		metadata.inventory.data?.generatedAt ?? metadata.inventory.fetchedAt ?? null,
	);
	const inventoryStale = $derived(
		Boolean(metadata.inventory.error) ||
			!metadata.inventory.data ||
			(inventoryAt ? now - Date.parse(inventoryAt) > 90_000 : true),
	);
	const envRows = $derived(deriveEnvRows(model, metadata, links.argoCdBase));
	const errors = $derived(
		[
			requestError,
			activityError,
			metadata.live.error,
			metadata.gitops.releasePinsError,
			metadata.inventory.error,
			promotions.error,
		].filter((m): m is string => Boolean(m)),
	);
	const needsYou = $derived(deriveNeedsYou(envRows, errors, streamState, inventoryStale));
	const runningNow = $derived(deriveRunningNow(envRows, changeJourneys));
	const evidenceJourney = $derived.by(() => {
		const target = evidenceTarget;
		if (target?.kind === "change") {
			return changeJourneys.find((journey) => journey.id === target.id) ?? null;
		}
		if (target?.kind === "environment") {
			return (
				changeJourneys.find((journey) => journey.environments.includes(target.env)) ??
				null
			);
		}
		return selectedJourney;
	});
	const evidenceEnv = $derived.by(() => {
		const target = evidenceTarget;
		return target?.kind === "environment"
			? (envRows.find((row) => row.env === target.env) ?? null)
			: null;
	});
	const evidenceDisplaySteps = $derived(evidenceSteps(evidenceJourney, evidenceEnv));

	async function refresh(options: { fresh?: boolean } = {}) {
		loading = true;
		try {
			const [metaRes, promoRes, eventsRes] = await Promise.all([
				fetch(gitOpsDeploymentMetadataUrl(options)),
				fetch("/api/v1/gitops/promotions"),
				fetch("/api/v1/gitops/events?limit=200"),
			]);
			if (!metaRes.ok) throw new Error(`metadata: ${metaRes.status} ${metaRes.statusText}`);
			if (!promoRes.ok) throw new Error(`promotions: ${promoRes.status} ${promoRes.statusText}`);
			if (!eventsRes.ok) throw new Error(`events: ${eventsRes.status} ${eventsRes.statusText}`);
			metadata = (await metaRes.json()) as DeploymentMetadataResponse;
			promotions = (await promoRes.json()) as PromotionStrategiesResponse;
			const activity = (await eventsRes.json()) as GitOpsActivityEventsResponse;
			for (const event of activity.events) {
				lastSeenSequence = Math.max(lastSeenSequence, event.sequence);
				const observed = Date.parse(event.observedAt);
				if (!Number.isNaN(observed) && observed > (lastEventAt ?? 0)) lastEventAt = observed;
			}
			activityEvents = mergeActivityEvents(
				activityEvents,
				activity.events.filter((e) => !isInventoryActivityEvent(e)),
			);
			requestError = null;
		} catch (err) {
			requestError = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		applySelectParam();
		startFallbackPolling();
		clockStop = startClock();
		connectActivityStream();
	});

	function applySelectParam() {
		const id = page.url.searchParams.get("select");
		if (!id) return;
		if (id.startsWith("stage/")) {
			const stageName = id.slice("stage/".length);
			const env = stageName.split("::")[1];
			if (env === "dev" || env === "ryzen") evidenceTarget = { kind: "environment", env };
		}
		const url = new URL(page.url);
		url.searchParams.delete("select");
		void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
	}

	onDestroy(() => {
		stopFallbackPolling();
		clockStop?.();
		flushEvents();
		if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
		closeActivityStream();
		if (activityReconnectTimer) clearTimeout(activityReconnectTimer);
		clearFlowing();
	});

	function latestSequence(): number {
		return activityEvents.reduce((max, event) => Math.max(max, event.sequence), lastSeenSequence);
	}

	const POLL_FALLBACK_MS = 15_000;
	const POLL_SAFETY_MS = 60_000;

	function startFallbackPolling(intervalMs: number = POLL_FALLBACK_MS) {
		stopFallbackPolling();
		timer = setInterval(() => void refresh(), intervalMs);
	}

	function stopFallbackPolling() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	function scheduleMetadataRefresh() {
		if (eventRefreshTimer) clearTimeout(eventRefreshTimer);
		eventRefreshTimer = setTimeout(() => {
			eventRefreshTimer = null;
			void refresh();
		}, GITOPS_EVENT_REFRESH_DEBOUNCE_MS);
	}

	function flushEvents() {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		if (eventBuffer.length === 0) return;
		const batch = eventBuffer;
		eventBuffer = [];
		if (batch.length > 0) lastEventAt = Date.now();
		const feedEvents = batch.filter((e) => !isInventoryActivityEvent(e));
		if (feedEvents.length > 0) activityEvents = mergeActivityEvents(activityEvents, feedEvents);
		const keys = new Set<string>();
		let refreshNeeded = false;
		for (const event of batch) {
			lastSeenSequence = Math.max(lastSeenSequence, event.sequence);
			for (const key of activityTargetKeys(event, baseModel)) keys.add(key);
			if (shouldRefreshGitOpsMetadata(event)) refreshNeeded = true;
		}
		if (keys.size > 0) markFlowing([...keys]);
		if (refreshNeeded) scheduleMetadataRefresh();
	}

	function scheduleFlush() {
		if (flushTimer) return;
		flushTimer = setTimeout(flushEvents, 80);
	}

	function closeActivityStream() {
		activityEventSource?.close();
		activityEventSource = null;
		activityConnected = false;
	}

	function connectActivityStream() {
		closeActivityStream();
		activityReconnecting = false;
		if (activityReconnectTimer) {
			clearTimeout(activityReconnectTimer);
			activityReconnectTimer = null;
		}
		const es = new EventSource(`/api/v1/gitops/events/stream?since=${latestSequence()}`);
		activityEventSource = es;
		es.onopen = () => {
			activityConnected = true;
			activityReconnecting = false;
			activityError = null;
			reconnectDelay = 3000;
			startFallbackPolling(POLL_SAFETY_MS);
		};
		es.addEventListener("gitops.event", (event) => {
			const message = event as MessageEvent<string>;
			try {
				eventBuffer.push(JSON.parse(message.data) as GitOpsActivityEvent);
				scheduleFlush();
			} catch (err) {
				activityError = err instanceof Error ? err.message : String(err);
			}
		});
		es.onerror = () => {
			activityConnected = false;
			activityError = null;
			es.close();
			startFallbackPolling(POLL_FALLBACK_MS);
			if (!activityReconnectTimer) {
				activityReconnecting = true;
				const delay = reconnectDelay;
				reconnectDelay = Math.min(reconnectDelay * 1.5, 30_000);
				activityReconnectTimer = setTimeout(() => {
					activityReconnectTimer = null;
					connectActivityStream();
				}, delay);
			}
		};
	}

	function openEnvironment(row: EnvOverview) {
		selectedJourneyId = null;
		evidenceTarget = { kind: "environment", env: row.env };
		selection = row.stage ? { kind: "stage", id: `stage/${row.stage.name}` } : null;
	}

	function openJourney(journey: ChangeJourney) {
		selectedJourneyId = journey.id;
		evidenceTarget = { kind: "change", id: journey.id };
		selection = journey.primarySelection
			? {
					kind: journey.primarySelection.kind,
					id:
						journey.primarySelection.kind === "stage"
							? journey.primarySelection.id
							: journey.primarySelection.id,
				}
			: null;
	}

	function selectGraphNode(sel: PipelineSelection) {
		selection = sel;
		if (sel?.kind === "stage") {
			const env = sel.id.slice("stage/".length).split("::")[1];
			if (env === "dev" || env === "ryzen") evidenceTarget = { kind: "environment", env };
		}
	}

	function closeEvidence() {
		evidenceTarget = null;
		selectedJourneyId = null;
		selection = null;
	}

	function deriveEnvRows(
		currentModel: PipelineModel,
		currentMetadata: DeploymentMetadataResponse,
		argoCdBase: string,
	): EnvOverview[] {
		return (["dev", "ryzen"] as const).map((env) => {
			const stages = currentModel.stages.filter((stage) => stage.env === env && !stage.dormant);
			const primary =
				stages.find((stage) => stage.warehouse === "workflow-builder") ??
				stages.find((stage) => stage.warehouse === "release-pins") ??
				stages[0] ??
				null;
			const degraded = stages.some((stage) => stage.health === "Degraded");
			const deploying = stages.some(
				(stage) =>
					stage.build?.phase === "building" ||
					stage.promotion?.inFlight ||
					stage.activity?.passing === false && stage.activity?.failed === false,
			);
			const drifted = stages.some(
				(stage) =>
					stage.drift === "pending_rollout" ||
					stage.syncStatus === "OutOfSync" ||
					Boolean(stage.desiredTag && stage.liveTag && stage.desiredTag !== stage.liveTag),
			);
			const awaiting = stages.some((stage) => stage.awaitingReconcile);
			const status: EnvStatus = degraded
				? "Degraded"
				: deploying
					? "Deploying"
					: drifted || awaiting
						? "Out-of-date"
						: "Healthy";
			const runningSha =
				primary?.commitSha ??
				primary?.provenance?.commitSha ??
				commitFromTag(primary?.liveTag) ??
				commitFromTag(primary?.desiredTag);
			const runningAt =
				primary?.updatedAt ??
				primary?.provenance?.committedAt ??
				primary?.provenance?.pinCommittedAt ??
				null;
			const leadMs = leadTime(primary);
			const live = env === currentMetadata.environment.name ? currentMetadata.live.deployments : [];
			const capacity = capacityInfo(live);
			return {
				env,
				status,
				reason: statusReason(status, stages),
				stage: primary,
				runningSha,
				runningAt,
				service: primary?.warehouse === "release-pins" ? "workflow-builder" : (primary?.warehouse ?? "workflow-builder"),
				image: shortTag(primary?.liveTag ?? primary?.desiredTag, 22),
				drifted,
				driftLabel: drifted ? driftReason(stages) : null,
				leadMs,
				capacity: capacity.label,
				capacityReady: capacity.ready,
				capacityDesired: capacity.desired,
				capacityRestarts: capacity.restarts,
				health: healthLabel(stages),
				actionHref: primary ? argoAppUrl(argoCdBase, env, primary.warehouse) : null,
				inFlight: deploying,
			};
		});
	}

	function deriveNeedsYou(
		rows: EnvOverview[],
		errorList: string[],
		currentStreamState: string,
		staleInventory: boolean,
	) {
		const items: { key: string; reason: string; action: string; env?: EnvName; href?: string | null }[] = [];
		for (const row of rows) {
			if (row.status === "Degraded") {
				items.push({
					key: `${row.env}-degraded`,
					reason: `${row.env} is degraded: ${row.reason}`,
					action: "Inspect evidence",
					env: row.env,
				});
			} else if (row.status === "Out-of-date") {
				items.push({
					key: `${row.env}-drift`,
					reason: `${row.env} is out of date: ${row.driftLabel ?? row.reason}`,
					action: "Review rollout",
					env: row.env,
				});
			}
		}
		if (currentStreamState === "degraded" || currentStreamState === "poll") {
			items.push({
				key: "stream",
				reason: "Event stream is not current; overview is relying on polling.",
				action: "Refresh",
			});
		}
		if (staleInventory) {
			items.push({
				key: "inventory",
				reason: "Deployment inventory is stale or unavailable.",
				action: "Refresh",
			});
		}
		if (errorList.length > 0) {
			items.push({
				key: "errors",
				reason: operatorErrorCause(errorList[0]!),
				action: "Refresh",
			});
		}
		return items;
	}

	function operatorErrorCause(message: string): string {
		const lower = message.toLowerCase();
		if (lower.includes("forbidden") || lower.includes("403")) {
			return "A data source denied access, so part of the overview may be incomplete.";
		}
		if (lower.includes("timeout") || lower.includes("timed out")) {
			return "A data source timed out while refreshing the overview.";
		}
		if (lower.includes("network") || lower.includes("fetch")) {
			return "A data source could not be reached during the last refresh.";
		}
		if (lower.includes("metadata")) return "Deployment metadata could not be refreshed.";
		if (lower.includes("promotions")) return "Promotion status could not be refreshed.";
		if (lower.includes("events")) return "Recent change evidence could not be refreshed.";
		return "One data source reported an issue during the last refresh.";
	}

	function deriveRunningNow(rows: EnvOverview[], journeys: ChangeJourney[]) {
		const activeChanges = journeys.filter((journey) => journey.status === "active" || journey.status === "waiting");
		const deploys = rows.filter((row) => row.inFlight).length;
		const previews = rows.filter((row) => row.actionHref).length;
		return {
			activeChanges: activeChanges.length,
			deploys,
			previews,
			label:
				activeChanges.length === 0 && deploys === 0
					? "No builds or deploys in flight"
					: `${activeChanges.length} change${activeChanges.length === 1 ? "" : "s"} moving, ${deploys} deploy${deploys === 1 ? "" : "s"} active`,
			previewsLabel: `${previews} live environment${previews === 1 ? "" : "s"} linked`,
		};
	}

	function statusReason(status: EnvStatus, stages: PipelineStage[]): string {
		if (stages.length === 0) return "No environment data reported";
		if (status === "Degraded") {
			const failed = stages.find((stage) => stage.health === "Degraded");
			return failed ? `${failed.warehouse} reports degraded health` : "Service health failed";
		}
		if (status === "Deploying") {
			const build = stages.find((stage) => stage.build?.phase === "building");
			if (build) return `${build.warehouse} build is running`;
			const promotion = stages.find((stage) => stage.promotion?.inFlight);
			if (promotion) return `${promotion.warehouse} promotion is in progress`;
			return "Rollout activity is in progress";
		}
		if (status === "Out-of-date") return driftReason(stages) ?? "Desired and live state differ";
		return "Desired state is live and healthy";
	}

	function driftReason(stages: PipelineStage[]): string | null {
		const drift = stages.find((stage) => stage.desiredTag && stage.liveTag && stage.desiredTag !== stage.liveTag);
		if (drift) return `${drift.warehouse} desired ${shortTag(drift.desiredTag)} / live ${shortTag(drift.liveTag)}`;
		const outOfSync = stages.find((stage) => stage.syncStatus === "OutOfSync");
		if (outOfSync) return `${outOfSync.warehouse} desired state is not synced`;
		const pending = stages.find((stage) => stage.drift === "pending_rollout" || stage.awaitingReconcile);
		if (pending) return `${pending.warehouse} rollout is pending`;
		return null;
	}

	function healthLabel(stages: PipelineStage[]): string {
		if (stages.length === 0) return "Not reported";
		const degraded = stages.filter((stage) => stage.health === "Degraded").length;
		const healthy = stages.filter((stage) => stage.health === "Healthy").length;
		if (degraded > 0) return `${degraded} degraded, ${healthy}/${stages.length} healthy`;
		return `${healthy}/${stages.length} services healthy`;
	}

	function capacityInfo(live: DeploymentMetadataResponse["live"]["deployments"]) {
		if (live.length === 0) {
			return { label: "Not reported", ready: null, desired: null, restarts: null };
		}
		const ready = live.reduce((sum, deployment) => sum + (deployment.readyReplicas ?? 0), 0);
		const desired = live.reduce((sum, deployment) => sum + (deployment.replicas ?? 0), 0);
		const restarts = live.reduce(
			(sum, deployment) =>
				sum +
				deployment.containers.reduce((inner, container) => inner + (container.restartCount ?? 0), 0),
			0,
		);
		return { label: `${ready}/${desired} ready, ${restarts} restarts`, ready, desired, restarts };
	}

	function capacityPercent(row: EnvOverview): number {
		if (!row.capacityDesired || row.capacityReady == null) return 0;
		return Math.max(0, Math.min(100, Math.round((row.capacityReady / row.capacityDesired) * 100)));
	}

	function leadTime(stage: PipelineStage | null): number | null {
		if (!stage) return null;
		const start = parseIso(stage.provenance?.committedAt ?? stage.provenance?.pinCommittedAt ?? null);
		const end = parseIso(stage.updatedAt ?? stage.build?.finishedAt ?? null);
		if (start == null || end == null || end < start) return null;
		return end - start;
	}

	function stepDuration(step: EvidenceStep, previous: EvidenceStep | null): string {
		const current = parseIso(step.at);
		const prior = parseIso(previous?.at ?? null);
		if (current == null || prior == null || current < prior) return "duration not reported";
		return formatDurationMs(current - prior);
	}

	function commitFromTag(tag: string | null | undefined): string | null {
		const match = tag?.match(/^git-([0-9a-f]{7,40})$/i);
		return match ? match[1] : null;
	}

	function parseIso(value: string | null | undefined): number | null {
		if (!value) return null;
		const parsed = Date.parse(value);
		return Number.isNaN(parsed) ? null : parsed;
	}

	function compactAge(ms: number | null): string | null {
		if (ms === null) return null;
		const minutes = Math.floor(ms / 60_000);
		if (minutes < 1) return "<1m";
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return `${hours}h ${minutes % 60}m`;
		return `${Math.floor(hours / 24)}d`;
	}

	function argoAppUrl(base: string | null | undefined, env: string, service: string): string | null {
		if (!base) return null;
		return `${base.replace(/\/+$/, "")}/applications/${env}-${service}`;
	}

	function evidenceSteps(journey: ChangeJourney | null, env: EnvOverview | null): EvidenceStep[] {
		const findStep = (kinds: ChangeJourneyStep["kind"][]) =>
			journey?.steps.find((step) => kinds.includes(step.kind)) ?? null;
		const firstStep = journey?.steps[0] ?? null;
		const commitSha = journey?.sourceCommitSha ?? env?.runningSha ?? null;
		const commitHref = commitSha
			? journey?.repoLabel === "stacks"
				? `${links.stacksRepo}/commit/${commitSha}`
				: `${links.workflowBuilderRepo}/commit/${commitSha}`
			: null;
		const commitAt = firstStep?.at ?? env?.runningAt ?? null;
		const build = findStep(["build"]);
		const pin = findStep(["pin"]);
		const promote = findStep(["promote"]);
		const deploy = findStep(["deploy", "argocd-sync"]);
		return [
			{
				id: "commit",
				label: "Commit",
				state: commitSha ? "done" : "skipped",
				at: commitAt,
				detail: commitSha ? shortSha(commitSha) : "Commit not reported",
				href: commitHref,
				hrefLabel: "Open commit",
			},
			stepOrPlaceholder("build", "Build", build),
			stepOrPlaceholder("pin", "Pin", pin),
			stepOrPlaceholder("promote", "Promote", promote),
			stepOrPlaceholder("deploy", "Deploy", deploy),
		];
	}

	function stepOrPlaceholder(
		id: string,
		label: EvidenceStep["label"],
		step: ChangeJourneyStep | null,
	): EvidenceStep {
		return {
			id,
			label,
			state: step?.state ?? "skipped",
			at: step?.at ?? null,
			detail: step?.detail ?? `${label} not reported`,
			href: step?.href ?? null,
			hrefLabel: step?.hrefLabel ?? null,
		};
	}
</script>

<svelte:head>
	<title>GitOps system · Workflow Builder</title>
</svelte:head>

<div class="command-center flex h-full min-w-0 flex-col overflow-hidden bg-[#f7f6f2] text-[#232826]">
	<header class="border-b border-[#d9d7cf] bg-[#fbfaf7] px-5 py-3">
		<div class="header-line flex flex-wrap items-center justify-between gap-3">
			<div class="header-provenance flex min-w-0 items-center gap-2">
				<Route class="size-5 shrink-0 text-[#66706b]" />
				<h1 class="truncate text-lg font-semibold tracking-normal">GitOps system</h1>
				<a
					class="inline-flex items-center gap-1 rounded border border-[#d9d7cf] px-2 py-0.5 text-[0.7rem] text-[#66706b] hover:text-[#232826]"
					href={stacksUrl}
					target="_blank"
					rel="noreferrer"
				>
					<GitBranch class="size-3" />
					source stacks/main <span class="font-mono">{stacksShortSha}</span>
				</a>
				<span
					class="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[0.7rem] {streamState ===
					'degraded'
						? 'border-[#b8872f]/50 text-[#8a641f]'
						: 'border-[#d9d7cf] text-[#66706b]'}"
					title={`Event stream ${streamState}; latest sequence ${latestSequence()}`}
				>
					{#if streamState === "degraded"}
						<AlertTriangle class="size-3" />
					{:else}
						<Radio class="size-3" />
					{/if}
					stream {streamState}{streamAgeLabel ? ` ${streamAgeLabel}` : ""}
				</span>
				<span
					class="inline-flex items-center gap-1 rounded border px-2 py-0.5 text-[0.7rem] {inventoryStale
						? 'border-[#b8872f]/50 text-[#8a641f]'
						: 'border-[#d9d7cf] text-[#66706b]'}"
					title={metadata.inventory.error
						? "Deployment inventory could not be refreshed"
						: "Deployment inventory snapshot freshness"}
				>
					{#if inventoryStale}<AlertTriangle class="size-3" />{/if}
					inventory {inventoryAt ? relativeTime(inventoryAt, now) : "unavailable"}
				</span>
			</div>
			<div class="flex items-center gap-2">
				<span class="hidden text-[0.7rem] text-[#66706b] md:inline">
					snapshot {relativeTime(metadata.generatedAt, now)}
				</span>
				<Button
					variant="outline"
					size="sm"
					onclick={() => void refresh({ fresh: true })}
					disabled={loading}
					class="h-7 border-[#c9c5ba] bg-transparent"
				>
					<RefreshCw class="size-3.5" />
					{loading ? "Refreshing" : "Refresh"}
				</Button>
			</div>
		</div>
	</header>

	<main class="min-h-0 min-w-0 flex-1 overflow-auto px-5 py-4">
		<section aria-labelledby="needs-you-heading" class="needs-you mb-4 rounded border border-[#d9d7cf] bg-[#fbfaf7]">
			<div class="needs-you-grid grid items-stretch">
				<div class="min-w-0">
					<div class="flex items-center gap-2">
						<h2 id="needs-you-heading" class="text-sm font-semibold">Needs you</h2>
						<span class="attention-count">{needsYou.length === 0 ? "all clear" : `${needsYou.length} item${needsYou.length === 1 ? "" : "s"}`}</span>
					</div>
					{#if needsYou.length === 0}
						<p class="attention-copy mt-1 text-sm text-[#66706b]">
							Nothing needs your attention. {runningNow.label}; {runningNow.previewsLabel}.
						</p>
					{:else}
						<div class="needs-list mt-2 flex flex-col gap-2">
							{#each needsYou as item (item.key)}
								<div class="flex flex-wrap items-center gap-2 text-sm">
									<AlertTriangle class="size-4 shrink-0 text-[#a6503b]" />
									<span>{item.reason}</span>
									{#if item.env}
										<button class="inline-action" type="button" onclick={() => {
											const row = envRows.find((candidate) => candidate.env === item.env);
											if (row) openEnvironment(row);
										}}>
											{item.action}
										</button>
									{:else}
										<button class="inline-action" type="button" onclick={() => void refresh({ fresh: true })}>
											{item.action}
										</button>
									{/if}
								</div>
							{/each}
						</div>
					{/if}
				</div>
				<div class="ops-signature" aria-label="Live system summary">
					<div>
						<span>{runningNow.activeChanges}</span>
						<small>active changes</small>
					</div>
					<div>
						<span>{runningNow.deploys}</span>
						<small>deploys now</small>
					</div>
					<div>
						<span>{envRows.filter((row) => row.status === "Healthy").length}/{envRows.length}</span>
						<small>healthy envs</small>
					</div>
				</div>
			</div>
		</section>

		<section aria-label="Environment status board" class="status-board overflow-hidden rounded border border-[#d9d7cf] bg-[#fbfaf7]">
			<div class="status-board-header board-grid grid border-b border-[#d9d7cf] px-3 py-2 text-[0.68rem] font-medium uppercase tracking-normal text-[#66706b]">
				<div>Environment</div>
				<div>Status</div>
				<div>Running</div>
				<div>Age</div>
				<div>Drift</div>
				<div>Lead time</div>
				<div>Capacity</div>
				<div>Health</div>
			</div>
			{#each envRows as row (row.env)}
				<button
					type="button"
				class="env-row board-grid row-status-{row.status.toLowerCase().replace('-', '')} grid w-full items-center border-b border-[#e5e2da] px-3 py-3 text-left text-sm last:border-b-0 hover:bg-[#f3f1ea] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#5f7661]"
				aria-label={`${row.env} environment details`}
				onclick={() => openEnvironment(row)}
			>
					<div class="min-w-0">
						<span class="mobile-label">Environment</span>
						<div class="font-medium">{row.env}</div>
						<div class="truncate text-[0.72rem] text-[#66706b]">{row.service} · {row.image}</div>
					</div>
					<div>
						<span class="mobile-label">Status</span>
						<span
							data-status-chip={row.env}
							aria-label={`${row.env} status ${row.status}`}
							class="status-chip status-{row.status.toLowerCase().replace('-', '')}"
						>
							{row.status}
						</span>
					</div>
					<div class="font-mono text-[0.78rem]">
						<span class="mobile-label">Running</span>
						{shortSha(row.runningSha)}
					</div>
					<div class="text-[0.78rem] text-[#66706b]">
						<span class="mobile-label">Age</span>
						{row.runningAt ? relativeTime(row.runningAt, now) : "Not reported"}
					</div>
					<div class="min-w-0 text-[0.78rem]">
						<span class="mobile-label">Drift</span>
						{#if row.drifted}
							<span class="drift-indicator truncate" title={row.driftLabel ?? "Desired and live differ"}>
								{row.driftLabel ?? "desired differs"}
							</span>
						{:else}
							<span class="text-[#9a9b94]">—</span>
						{/if}
					</div>
					<div class="lead-cell text-[0.78rem] tabular-nums">
						<span class="mobile-label">Lead time</span>
					<div class="lead-ruler" aria-label={`${row.env} commit to live ${formatDurationMs(row.leadMs)}`}>
						<div class="lead-ruler-labels">
							<span class="lead-anchor">{shortSha(row.runningSha)}</span>
							<span>{row.runningAt ? relativeTime(row.runningAt, now) : "live time not reported"}</span>
						</div>
						<div class="lead-ruler-track">
							<span class="lead-ruler-node start"></span>
							<span class="lead-ruler-tick tick-build">Build</span>
							<span class="lead-ruler-tick tick-pin">Pin</span>
							<span class="lead-ruler-tick tick-live">Live</span>
							<span class="lead-ruler-fill slow-{row.leadMs !== null && row.leadMs > 30 * 60_000}"></span>
							<span class="lead-ruler-node end"></span>
						</div>
						<div class="lead-ruler-duration">commit to live · {formatDurationMs(row.leadMs)}</div>
					</div>
				</div>
					<div class="capacity-cell text-[0.78rem] text-[#66706b]">
						<span class="mobile-label">Capacity</span>
						<div class="capacity-meter" aria-label={`${row.env} capacity ${row.capacity}`}>
							<div class="capacity-meter-label">
								<span>{row.capacityReady == null ? "Not reported" : `${row.capacityReady}/${row.capacityDesired} ready`}</span>
								{#if row.capacityRestarts != null}
									<small>{row.capacityRestarts} restarts</small>
								{/if}
							</div>
							<div class="capacity-track" aria-hidden="true">
								<span style:width={`${capacityPercent(row)}%`}></span>
							</div>
						</div>
					</div>
					<div class="truncate text-[0.78rem] text-[#66706b]">
						<span class="mobile-label">Health</span>
						{row.health}
					</div>
				</button>
			{/each}
		</section>

		<div class="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
			<section aria-labelledby="recent-heading" class="rounded border border-[#d9d7cf] bg-[#fbfaf7]">
				<div class="flex items-center justify-between border-b border-[#d9d7cf] px-3 py-2">
					<h2 id="recent-heading" class="text-sm font-semibold">My recent changes</h2>
					<span class="text-[0.72rem] text-[#66706b]">{changeJourneys.length} shown</span>
				</div>
				{#if changeJourneys.length === 0}
					<p class="px-3 py-6 text-sm text-[#66706b]">No recent change evidence has been reported.</p>
				{:else}
					<div class="divide-y divide-[#e5e2da]">
						{#each changeJourneys.slice(0, 6) as journey (journey.id)}
							<button
								type="button"
								class="change-row w-full px-3 py-3 text-left hover:bg-[#f3f1ea] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#5f7661]"
								onclick={() => openJourney(journey)}
							>
								<div class="flex flex-wrap items-center justify-between gap-2">
									<div class="min-w-0">
										<div class="truncate text-sm font-medium">{journey.title}</div>
										<div class="truncate text-[0.72rem] text-[#66706b]">
											{journey.subtitle ?? "change evidence"} · {journey.updatedAt ? relativeTime(journey.updatedAt, now) : "time not reported"}
										</div>
									</div>
									<span class="text-[0.72rem] capitalize text-[#66706b]">{journey.status}</span>
								</div>
								<div class="mt-3 grid grid-cols-5 gap-1">
									{#each ["Commit", "Build", "Pin", "Promote", "Deploy"] as label}
										{@const step = evidenceSteps(journey, null).find((candidate) => candidate.label === label)}
										<div class="step-compact step-{step?.state ?? 'skipped'}">
											<span>{label}</span>
											<small>{step?.at ? relativeTime(step.at, now) : "—"}</small>
										</div>
									{/each}
								</div>
							</button>
						{/each}
					</div>
				{/if}
			</section>

			<aside class="rounded border border-[#d9d7cf] bg-[#fbfaf7] p-3">
				<h2 class="text-sm font-semibold">Capacity and usage</h2>
				<div class="mt-3 space-y-3 text-sm">
					<div>
						<div class="text-[0.72rem] text-[#66706b]">Agent fleet utilization</div>
						<div class="mt-0.5 font-medium">{envRows.map((row) => `${row.env} ${row.capacity}`).join(" · ")}</div>
					</div>
					<div>
						<div class="text-[0.72rem] text-[#66706b]">Token and cost</div>
						<div class="mt-0.5 font-medium">Not reported by GitOps inventory</div>
					</div>
					<div>
						<div class="text-[0.72rem] text-[#66706b]">Resource pressure</div>
						<div class="mt-0.5 font-medium">
							{inventoryStale ? "Inventory freshness needs review" : "No pressure signal reported"}
						</div>
					</div>
				</div>
			</aside>
		</div>

		<section class="mt-4 rounded border border-[#d9d7cf] bg-[#fbfaf7]">
			<div class="flex flex-wrap items-center justify-between gap-3 border-b border-[#d9d7cf] px-3 py-2">
				<div>
					<h2 class="text-sm font-semibold">Topology</h2>
					<p class="text-[0.72rem] text-[#66706b]">Optional dependency map for deeper inspection.</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					class="graph-toggle h-8 border-[#c9c5ba] bg-transparent"
					onclick={() => (showGraph = !showGraph)}
				>
					<ChevronsUpDown class="size-3.5" />
					{showGraph ? "Hide graph" : "Show graph"}
				</Button>
			</div>
			{#if showGraph}
				<div class="h-[560px]">
					<PipelineGraph
						{model}
						pipelineFilter={[]}
						hideSubscriptions={true}
						stepEdges={false}
						showMinimap={false}
						groupLanes={false}
						stageSearch=""
						selected={selection}
						onselect={selectGraphNode}
						freightHighlight={activeHighlight}
						statusFilter={[]}
					/>
				</div>
			{/if}
		</section>
	</main>

	{#if evidenceTarget}
		<div class="evidence-shell border-t border-[#d9d7cf] bg-[#fbfaf7]">
			<div class="flex items-center justify-between gap-3 border-b border-[#d9d7cf] px-5 py-3">
				<div>
					<h2 class="text-sm font-semibold">Evidence timeline</h2>
					<p class="text-[0.72rem] text-[#66706b]">
						{#if evidenceJourney}
							{evidenceJourney.title}
						{:else if evidenceEnv}
							{evidenceEnv.env} environment · {evidenceEnv.reason}
						{:else}
							No evidence selected
						{/if}
					</p>
				</div>
				<Button variant="ghost" size="icon" class="size-8" onclick={closeEvidence} aria-label="Close evidence">
					<X class="size-4" />
				</Button>
			</div>
			<div class="grid gap-4 px-5 py-4 lg:grid-cols-[minmax(0,1fr)_16rem]">
				<div class="timeline">
					{#if evidenceDisplaySteps.length === 0}
						<p class="text-sm text-[#66706b]">No Commit to Build to Pin to Promote to Deploy evidence has been reported yet.</p>
					{:else}
						{#each evidenceDisplaySteps as step, index (step.id)}
							{@const previous = index > 0 ? (evidenceDisplaySteps[index - 1] ?? null) : null}
							<div class="timeline-step">
								<div class="timeline-dot state-{step.state}">
									{#if step.state === "done"}<CheckCircle2 class="size-3" />{:else}<Clock3 class="size-3" />{/if}
								</div>
								<div class="min-w-0">
									<div class="flex flex-wrap items-center gap-2">
										<span class="text-sm font-medium">{step.label}</span>
										<span class="text-[0.72rem] text-[#66706b]">{step.at ? formatAbsoluteTime(step.at, now) : "timestamp not reported"}</span>
										<span class="text-[0.72rem] text-[#66706b]">· {stepDuration(step, previous)}</span>
									</div>
									<div class="mt-0.5 truncate text-[0.78rem] text-[#66706b]">{step.detail ?? "No additional detail"}</div>
								</div>
								{#if step.href}
									<a class="timeline-link" href={step.href} target="_blank" rel="noreferrer">
										{step.hrefLabel ?? "Open"} <ExternalLink class="size-3" />
									</a>
								{/if}
							</div>
						{/each}
					{/if}
				</div>
				<div class="space-y-3 text-sm">
					{#if evidenceEnv}
						<div>
							<div class="text-[0.72rem] text-[#66706b]">Running</div>
							<div class="font-mono">{shortSha(evidenceEnv.runningSha)}</div>
						</div>
						<div>
							<div class="text-[0.72rem] text-[#66706b]">Lead time</div>
							<div>{formatDurationMs(evidenceEnv.leadMs)}</div>
						</div>
						{#if evidenceEnv.actionHref}
							<a class="inline-action" href={evidenceEnv.actionHref} target="_blank" rel="noreferrer">Open Argo CD</a>
						{/if}
					{/if}
					<a class="inline-action" href={links.deploymentInventory} target="_blank" rel="noreferrer">Open deployment inventory</a>
					{#if evidenceJourney?.steps.find((step) => step.kind === "build")?.detail}
						{@const run = evidenceJourney.steps.find((step) => step.kind === "build")?.detail}
						{@const href = tektonPipelineRunUrl(links.tektonBase, run)}
						{#if href}<a class="inline-action" href={href} target="_blank" rel="noreferrer">Open build run</a>{/if}
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.command-center {
		--quiet-border: #d9d7cf;
		--quiet-text: #66706b;
		--surface: #fbfaf7;
		--paper: #f7f6f2;
		background:
			linear-gradient(90deg, rgba(95, 118, 97, 0.08) 0, rgba(95, 118, 97, 0.08) 4px, transparent 4px),
			#f7f6f2;
		isolation: isolate;
	}
	.board-grid {
		grid-template-columns:
			minmax(7rem, 1.05fr) minmax(5.5rem, 0.82fr) minmax(5.75rem, 1fr)
			minmax(5.25rem, 0.85fr) minmax(8rem, 1.3fr) minmax(8.5rem, 1.3fr)
			minmax(8rem, 1.15fr) minmax(7rem, 1fr);
	}
	.header-provenance {
		flex-wrap: wrap;
	}
	.inline-action {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		border-bottom: 1px solid #5f7661;
		color: #415a43;
		font-size: 0.78rem;
		font-weight: 600;
	}
	.needs-you-grid {
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 1rem;
		padding: 0.85rem 1rem;
		background:
			linear-gradient(90deg, rgba(95, 118, 97, 0.14), transparent 19rem),
			var(--surface);
	}
	.attention-count {
		border: 1px solid #d9d7cf;
		border-radius: 999px;
		padding: 0.1rem 0.45rem;
		color: #66706b;
		font-size: 0.68rem;
		font-weight: 600;
		line-height: 1.1;
		white-space: nowrap;
	}
	.attention-copy {
		max-width: 64rem;
	}
	.needs-list {
		max-height: 9.5rem;
		overflow: auto;
		padding-right: 0.25rem;
	}
	.ops-signature {
		display: grid;
		grid-template-columns: repeat(3, minmax(4.5rem, 1fr));
		align-self: stretch;
		min-width: 18rem;
		overflow: hidden;
		border: 1px solid #dedbd2;
		background:
			linear-gradient(180deg, rgba(255, 255, 255, 0.52), rgba(247, 246, 242, 0.2)),
			rgba(247, 246, 242, 0.82);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.72);
	}
	.ops-signature > div {
		display: grid;
		align-content: center;
		gap: 0.15rem;
		border-left: 1px solid #dedbd2;
		padding: 0.45rem 0.7rem;
	}
	.ops-signature > div:first-child {
		border-left: 0;
	}
	.ops-signature span {
		color: #232826;
		font-size: 1rem;
		font-weight: 650;
		line-height: 1;
	}
	.ops-signature small {
		color: #66706b;
		font-size: 0.66rem;
		line-height: 1.05;
		white-space: nowrap;
	}
	.status-chip {
		display: inline-flex;
		align-items: center;
		border-radius: 999px;
		border: 1px solid #c9c5ba;
		padding: 0.125rem 0.5rem;
		font-size: 0.72rem;
		font-weight: 600;
		line-height: 1.2;
		white-space: nowrap;
		background: #f7f6f2;
		color: #4d5651;
	}
	.status-deploying {
		border-color: rgba(184, 135, 47, 0.45);
		background: rgba(184, 135, 47, 0.1);
		color: #7a5b21;
	}
	.status-degraded {
		border-color: rgba(166, 80, 59, 0.5);
		background: rgba(166, 80, 59, 0.1);
		color: #8a3f2e;
	}
	.status-outofdate {
		border-color: rgba(184, 135, 47, 0.35);
		background: rgba(184, 135, 47, 0.06);
		color: #6d5a35;
	}
	.env-row {
		position: relative;
		box-shadow: inset 4px 0 0 transparent;
	}
	.env-row.row-status-healthy {
		box-shadow: inset 4px 0 0 rgba(95, 118, 97, 0.22);
	}
	.env-row.row-status-deploying {
		box-shadow: inset 4px 0 0 rgba(184, 135, 47, 0.48);
	}
	.env-row.row-status-degraded {
		box-shadow: inset 4px 0 0 rgba(166, 80, 59, 0.55);
	}
	.env-row.row-status-outofdate {
		box-shadow: inset 4px 0 0 rgba(184, 135, 47, 0.3);
	}
	.mobile-label {
		display: none;
		color: #66706b;
		font-size: 0.68rem;
		font-weight: 600;
		line-height: 1.1;
		text-transform: uppercase;
	}
	.drift-indicator {
		display: inline-flex;
		max-width: 100%;
		border-left: 2px solid rgba(184, 135, 47, 0.55);
		padding-left: 0.45rem;
		color: #6d5a35;
	}
	.lead-ruler {
		display: grid;
		gap: 0.3rem;
		min-width: 0;
		border: 1px solid #dedbd2;
		background:
			linear-gradient(90deg, rgba(95, 118, 97, 0.12), transparent 55%),
			#f7f6f2;
		padding: 0.48rem 0.58rem;
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.7),
			0 1px 0 rgba(35, 40, 38, 0.03);
	}
	.lead-ruler-labels {
		display: flex;
		justify-content: space-between;
		gap: 0.5rem;
		color: #66706b;
		font-size: 0.68rem;
		line-height: 1.1;
	}
	.lead-ruler-labels span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.lead-anchor {
		color: #232826;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
		font-weight: 650;
	}
	.lead-ruler-track {
		position: relative;
		height: 0.58rem;
		border-radius: 999px;
		background:
			linear-gradient(90deg, rgba(35, 40, 38, 0.1), rgba(35, 40, 38, 0.03)),
			repeating-linear-gradient(90deg, transparent 0 18%, rgba(102, 112, 107, 0.24) 18% calc(18% + 1px), transparent calc(18% + 1px) 20%),
			#e6e2d8;
		box-shadow: inset 0 0 0 1px rgba(35, 40, 38, 0.04);
	}
	.lead-ruler-fill {
		display: block;
		position: absolute;
		left: 0.28rem;
		top: 50%;
		transform: translateY(-50%);
		height: 0.22rem;
		width: calc(100% - 0.56rem);
		border-radius: inherit;
		background: linear-gradient(90deg, rgba(95, 118, 97, 0.48), rgba(95, 118, 97, 0.2));
	}
	.lead-ruler-fill.slow-true {
		background: linear-gradient(90deg, rgba(184, 135, 47, 0.62), rgba(184, 135, 47, 0.26));
	}
	.lead-ruler-node {
		position: absolute;
		z-index: 2;
		top: 50%;
		height: 0.82rem;
		width: 0.82rem;
		border: 1px solid #8f978f;
		border-radius: 999px;
		background: #fbfaf7;
		transform: translateY(-50%);
		box-shadow: 0 0 0 3px #f7f6f2;
	}
	.lead-ruler-node.start {
		left: 0;
	}
	.lead-ruler-node.end {
		right: 0;
	}
	.lead-ruler-duration {
		color: #232826;
		font-size: 0.72rem;
		font-weight: 600;
		line-height: 1.1;
	}
	.lead-ruler-tick {
		position: absolute;
		top: 50%;
		z-index: 1;
		display: inline-flex;
		height: 1rem;
		align-items: center;
		border-left: 1px solid rgba(102, 112, 107, 0.4);
		padding-left: 0.22rem;
		color: rgba(102, 112, 107, 0.78);
		font-size: 0.58rem;
		line-height: 1;
		transform: translateY(-50%);
	}
	.tick-build {
		left: 28%;
	}
	.tick-pin {
		left: 56%;
	}
	.tick-live {
		left: calc(100% - 2rem);
	}
	.capacity-meter {
		display: grid;
		gap: 0.28rem;
		min-width: 0;
	}
	.capacity-meter-label {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.45rem;
		color: #4d5651;
		font-weight: 600;
		line-height: 1.1;
	}
	.capacity-meter-label span,
	.capacity-meter-label small {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.capacity-meter-label small {
		color: #66706b;
		font-size: 0.66rem;
		font-weight: 500;
	}
	.capacity-track {
		height: 0.34rem;
		overflow: hidden;
		border-radius: 999px;
		background: #e6e2d8;
		box-shadow: inset 0 0 0 1px rgba(35, 40, 38, 0.04);
	}
	.capacity-track span {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: rgba(95, 118, 97, 0.48);
	}
	.step-compact {
		min-height: 2.7rem;
		border: 1px solid #dedbd2;
		background: #f7f6f2;
		padding: 0.35rem 0.45rem;
		font-size: 0.72rem;
	}
	.step-compact span,
	.step-compact small {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.step-compact small {
		margin-top: 0.15rem;
		color: #66706b;
	}
	.step-active,
	.step-waiting {
		border-color: rgba(184, 135, 47, 0.45);
	}
	.step-failed {
		border-color: rgba(166, 80, 59, 0.5);
	}
	.status-board-header {
		box-shadow: inset 4px 0 0 rgba(95, 118, 97, 0.3);
	}
	.env-row:hover {
		box-shadow: inset 4px 0 0 rgba(95, 118, 97, 0.3);
	}
	.evidence-shell {
		max-height: 44vh;
		overflow: auto;
	}
	.timeline {
		display: grid;
		gap: 0.75rem;
	}
	.timeline-step {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: start;
		gap: 0.75rem;
	}
	.timeline-dot {
		margin-top: 0.1rem;
		display: inline-flex;
		size: 1.5rem;
		height: 1.5rem;
		width: 1.5rem;
		align-items: center;
		justify-content: center;
		border-radius: 999px;
		border: 1px solid #c9c5ba;
		color: #66706b;
	}
	.timeline-link {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: #415a43;
		font-size: 0.72rem;
		font-weight: 600;
	}
	@media (max-width: 980px) {
		.header-line {
			align-items: flex-start;
		}
		.header-provenance {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			width: 100%;
		}
		.header-provenance > a,
		.header-provenance > span {
			grid-column: 1 / -1;
			width: fit-content;
			max-width: 100%;
		}
		.header-provenance h1 {
			min-width: 0;
		}
		.status-board-header {
			display: none;
		}
		.needs-you-grid {
			grid-template-columns: 1fr;
			gap: 0.65rem;
			padding: 0.75rem;
		}
		.ops-signature {
			min-width: 0;
			width: 100%;
		}
		.env-row {
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: start;
			gap: 0.65rem 0.85rem;
			padding: 0.75rem 0.8rem;
		}
		.env-row > * {
			min-width: 0;
		}
		.env-row > :first-child {
			grid-column: 1;
			grid-row: 1;
		}
		.env-row > :nth-child(2) {
			grid-column: 2;
			grid-row: 1;
			justify-self: end;
		}
		.env-row > :nth-child(n + 3) {
			display: grid;
			gap: 0.2rem;
		}
		.env-row > :nth-child(3),
		.env-row > :nth-child(4),
		.env-row > :nth-child(7),
		.env-row > :nth-child(8) {
			grid-column: auto;
		}
		.env-row > :nth-child(5),
		.env-row > :nth-child(6) {
			grid-column: 1 / -1;
		}
		.mobile-label {
			display: block;
		}
		.lead-ruler {
			width: 100%;
		}
	}

	@media (max-width: 640px) {
		.command-center {
			min-width: 0;
			width: 100%;
		}
		.command-center main {
			padding-left: 0.75rem;
			padding-right: 0.75rem;
			padding-bottom: 5rem;
		}
		.command-center header {
			padding-left: 0.75rem;
			padding-right: 0.75rem;
		}
		.needs-you > div {
			align-items: flex-start;
		}
		.needs-list {
			max-height: none;
			overflow: visible;
			padding-right: 0;
		}
		.ops-signature {
			grid-template-columns: repeat(3, minmax(0, 1fr));
			border-radius: 0;
		}
		.ops-signature > div {
			padding: 0.4rem 0.45rem;
		}
		.ops-signature span {
			font-size: 0.88rem;
		}
		.ops-signature small {
			font-size: 0.6rem;
			white-space: normal;
		}
		.env-row {
			grid-template-columns: minmax(0, 1fr) max-content;
			gap: 0.55rem 0.7rem;
			padding: 0.68rem 0.7rem;
		}
		.env-row > :nth-child(3),
		.env-row > :nth-child(4),
		.env-row > :nth-child(7),
		.env-row > :nth-child(8) {
			min-height: 2.1rem;
			border-top: 1px solid #e5e2da;
			padding-top: 0.45rem;
		}
		.env-row > :nth-child(3),
		.env-row > :nth-child(7) {
			grid-column: 1;
		}
		.env-row > :nth-child(4),
		.env-row > :nth-child(8) {
			grid-column: 2;
			justify-self: end;
			text-align: right;
		}
		.env-row > :nth-child(5),
		.env-row > :nth-child(6) {
			grid-column: 1 / -1;
		}
		.lead-ruler {
			padding: 0.45rem 0.5rem;
		}
		.lead-ruler-tick {
			font-size: 0.54rem;
		}
		.capacity-meter-label {
			justify-content: flex-start;
		}
		.step-compact {
			padding: 0.3rem;
			font-size: 0.66rem;
		}
		.change-row .grid-cols-5 {
			grid-template-columns: repeat(5, minmax(3.4rem, 1fr));
			overflow-x: auto;
			padding-bottom: 0.15rem;
		}
		.evidence-shell {
			max-height: 58vh;
		}
		.timeline-step {
			grid-template-columns: auto minmax(0, 1fr);
		}
		.timeline-link {
			grid-column: 2;
		}
	}
</style>

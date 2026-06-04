<script lang="ts">
	import { onDestroy, onMount, untrack } from "svelte";
	import {
		AlertTriangle,
		ArrowRight,
		CheckCircle2,
		Clock3,
		Database,
		ExternalLink,
		GitBranch,
		GitCommit,
		Hammer,
		Package,
		RefreshCw,
		Route,
		Server,
		Workflow,
	} from "@lucide/svelte";

	import ArgoCDLogo from "$lib/components/gitops/icons/ArgoCDLogo.svelte";
	import TektonLogo from "$lib/components/gitops/icons/TektonLogo.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import {
		Tabs,
		TabsContent,
		TabsList,
		TabsTrigger,
	} from "$lib/components/ui/tabs";
	import {
		buildGitopsSystemViewModel,
		type SystemApplicationStatus,
		type SystemTone,
	} from "$lib/gitops/system-view";
	import {
		githubBranchUrl,
		githubCommitUrl,
		tektonRunUrl,
	} from "$lib/promoter/links";
	import type { PromotionStrategiesResponse } from "$lib/server/promoter/types";
	import type { DeploymentMetadataResponse } from "$lib/types/deployment-metadata";
	import {
		relativeTime,
		shortImage,
		shortSha,
		shortTag,
		statusVariant,
	} from "$lib/utils/gitops-display";

	import type { PageData } from "./$types";

	type Props = { data: PageData };
	let { data }: Props = $props();

	type RepoTab = "workflow-builder" | "stacks";
	type TimelineStep = {
		step: string;
		repo: "workflow-builder" | "stacks";
		title: string;
		summary: string;
		status: string;
		tone: SystemTone;
		href: string | null;
		linkLabel: string;
	};
	type EvidenceRow = {
		label: string;
		value: string;
		description: string;
		tone: SystemTone;
		href: string | null;
		linkLabel: string;
	};

	let metadata = $state<DeploymentMetadataResponse>(untrack(() => data.initial));
	let promotions = $state<PromotionStrategiesResponse>(untrack(() => data.promotions));
	const links = untrack(() => data.links);
	let loading = $state(false);
	let requestError = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | null = null;
	let clockTimer: ReturnType<typeof setInterval> | null = null;
	let now = $state(Date.now());
	let repoTab = $state<RepoTab>("workflow-builder");

	const view = $derived(buildGitopsSystemViewModel(metadata, promotions));
	const errors = $derived(
		[requestError, ...view.errors].filter((message): message is string => Boolean(message)),
	);
	const stacksShortSha = $derived(metadata.gitops.stacksMain?.shortSha ?? "unknown");
	const stacksUrl = $derived(metadata.gitops.stacksMain?.url ?? `${links.stacksRepo}/commits/main`);
	const releasePinsUrl = $derived(
		`${links.stacksRepo}/blob/main/${links.releasePinsPath}#:~:text=workflow-builder`,
	);
	const activePinTag = $derived(shortTag(view.activeWorkflowBuilderPin?.tag));
	const activePinSha = $derived(view.activeWorkflowBuilderPin?.commitSha ?? null);
	const activePinSourceSha = $derived(
		view.activeWorkflowBuilderPin?.sourceSha ?? activePinSha,
	);
	const activePinDigest = $derived(view.activeWorkflowBuilderPin?.digest ?? null);
	const activePinImageRef = $derived(view.activeWorkflowBuilderPin?.imageRef ?? null);
	const activePinPipelineRun = $derived(
		view.activeWorkflowBuilderPin?.pipelineRun ?? view.latestOuterLoopBuild?.pipelineRun ?? null,
	);
	const activePinCommitUrl = $derived(
		githubCommitUrl(links.workflowBuilderRepo, activePinSourceSha),
	);
	const liveImageLabel = $derived(
		view.currentWorkflowBuilderLive?.image
			? shortImage(view.currentWorkflowBuilderLive.image)
			: "No live image",
	);
	const latestTektonUrl = $derived(
		tektonRunUrl({ tektonBase: links.tektonBase }, activePinPipelineRun),
	);
	const devBranchUrl = $derived(githubBranchUrl(links.stacksRepo, "env/spokes-dev"));
	const ryzenOverlayUrl = $derived(`${links.stacksRepo}/tree/main/packages/overlays/ryzen`);
	const devOverlayUrl = $derived(
		`${links.stacksRepo}/tree/main/packages/components/workloads/workflow-builder-system-overlays/dev`,
	);
	const workflowBuilderMainUrl = $derived(githubBranchUrl(links.workflowBuilderRepo, "main"));
	const buildToneValue = $derived(buildTone());
	const pinToneValue = $derived(view.activeWorkflowBuilderPin ? "healthy" : "unknown");
	const liveToneValue = $derived(liveTone());
	const ryzenToneValue = $derived(
		combineTones([appTone(view.rootRyzen), appTone(view.ryzenWorkflowBuilder)]),
	);
	const devToneValue = $derived(
		combineTones([
			view.workflowBuilderRelease?.tone ?? "unknown",
			appTone(view.devWorkflowBuilder),
		]),
	);
	const currentSourceShaLabel = $derived(
		activePinSourceSha ? shortSha(activePinSourceSha) : "unknown source",
	);
	const digestLabel = $derived(activePinDigest ? shortDigest(activePinDigest) : "unknown");
	const buildFinishedLabel = $derived(
		view.latestOuterLoopBuild?.finishedAt
			? relativeTime(view.latestOuterLoopBuild.finishedAt, now)
			: "unknown",
	);
	const releasePinUpdatedLabel = $derived(
		view.activeWorkflowBuilderPin?.updatedAt
			? relativeTime(view.activeWorkflowBuilderPin.updatedAt, now)
			: "unknown",
	);
	const liveConfirmedLabel = $derived(
		metadata.inventory.data?.generatedAt
			? relativeTime(metadata.inventory.data.generatedAt, now)
			: relativeTime(metadata.generatedAt, now),
	);
	const releaseStatusLabel = $derived(
		view.workflowBuilderRelease?.activeBranch
			? `active on ${view.workflowBuilderRelease.activeBranch}`
			: "no promoter data",
	);

	const timelineSteps = $derived.by((): TimelineStep[] => [
		{
			step: "1",
			repo: "workflow-builder",
			title: "Source changes land",
			summary: "Application and service source starts in the workflow-builder repo.",
			status: currentSourceShaLabel,
			tone: activePinSourceSha ? "healthy" : "unknown",
			href: activePinCommitUrl ?? workflowBuilderMainUrl,
			linkLabel: activePinSourceSha ? "Open source commit" : "Open repo",
		},
		{
			step: "2",
			repo: "workflow-builder",
			title: "Hub builds the image",
			summary: "The GitHub webhook starts hub Tekton, which pushes the workflow-builder image to GHCR.",
			status: buildReasonLabel(),
			tone: buildToneValue,
			href: latestTektonUrl,
			linkLabel: "Open PipelineRun",
		},
		{
			step: "3",
			repo: "stacks",
			title: "Deployment intent is written",
			summary: "Release pins in stacks record the image tag, digest, source SHA, and generated dev overlay.",
			status: activePinTag,
			tone: pinToneValue,
			href: releasePinsUrl,
			linkLabel: "Open release pins",
		},
		{
			step: "4",
			repo: "stacks",
			title: "Ryzen reconciles directly",
			summary: "root-ryzen reads stacks main and applies overlays/ryzen through ryzen local ArgoCD.",
			status: appStatusLabel(view.ryzenWorkflowBuilder),
			tone: ryzenToneValue,
			href: argoAppUrl("ryzen-workflow-builder"),
			linkLabel: "Open ryzen app",
		},
		{
			step: "5",
			repo: "stacks",
			title: "Dev is promoted",
			summary: "Source Hydrator and GitOps Promoter move generated dev manifests to env/spokes-dev.",
			status: appStatusLabel(view.devWorkflowBuilder),
			tone: devToneValue,
			href: "/admin/gitops?tab=pipelines&strategy=workflow-builder-release",
			linkLabel: "Open promotion",
		},
		{
			step: "6",
			repo: "stacks",
			title: "Live deployments report back",
			summary: "Hub inventory compares desired pins, Argo state, and running images for operators.",
			status: liveImageLabel,
			tone: liveToneValue,
			href: links.deploymentInventory,
			linkLabel: "Open inventory",
		},
	]);

	const workflowEvidence = $derived.by((): EvidenceRow[] => [
		{
			label: "Source SHA",
			value: activePinSourceSha ? shortSha(activePinSourceSha) : "unknown",
			description: "Source commit associated with the active workflow-builder release pin.",
			tone: activePinSourceSha ? "healthy" : "unknown",
			href: activePinCommitUrl,
			linkLabel: "GitHub commit",
		},
		{
			label: "Latest PipelineRun",
			value: activePinPipelineRun ?? "no PipelineRun metadata",
			description: "Hub Tekton evidence from the outer-loop workflow-builder build.",
			tone: buildToneValue,
			href: latestTektonUrl,
			linkLabel: "Tekton Dashboard",
		},
		{
			label: "GHCR image",
			value: activePinImageRef ? shortImage(activePinImageRef) : activePinTag,
			description: "Image tag carried forward into stacks release metadata.",
			tone: pinToneValue,
			href: ghcrPackageUrl("workflow-builder"),
			linkLabel: "GHCR package",
		},
		{
			label: "Skaffold live pod",
			value: liveImageLabel,
			description: "Inner-loop edits can sync directly into the ryzen pod while Argo is paused for the dev session.",
			tone: liveToneValue,
			href: links.workflowBuilderRyzen,
			linkLabel: "Open ryzen app",
		},
	]);

	const stacksEvidence = $derived.by((): EvidenceRow[] => [
		{
			label: "stacks main",
			value: stacksShortSha,
			description: "Durable manifest source that ryzen reads directly and the hub hydrates for managed spokes.",
			tone: metadata.gitops.stacksMain ? "healthy" : "unknown",
			href: stacksUrl,
			linkLabel: "GitHub commit",
		},
		{
			label: "root-ryzen",
			value: appStatusLabel(view.rootRyzen),
			description: "Autonomous app-of-apps that reconciles packages/overlays/ryzen from main.",
			tone: appTone(view.rootRyzen),
			href: argoAppUrl("root-ryzen"),
			linkLabel: "ArgoCD app",
		},
		{
			label: "ryzen-workflow-builder",
			value: view.ryzenWorkflowBuilder?.liveImage
				? shortImage(view.ryzenWorkflowBuilder.liveImage)
				: appStatusLabel(view.ryzenWorkflowBuilder),
			description: "Ryzen workflow-builder application state from inventory or local metadata.",
			tone: appTone(view.ryzenWorkflowBuilder),
			href: argoAppUrl("ryzen-workflow-builder"),
			linkLabel: "ArgoCD app",
		},
		{
			label: "workflow-builder-release",
			value: releaseStatusLabel,
			description: "Promoter state for the dev release lane. Ryzen does not use this promotion path.",
			tone: view.workflowBuilderRelease?.tone ?? "unknown",
			href: "/admin/gitops?tab=pipelines&strategy=workflow-builder-release",
			linkLabel: "Promotion details",
		},
		{
			label: "workflow-builder-soak",
			value: view.workflowBuilderSoak?.phase ?? "no soak data",
			description:
				view.workflowBuilderSoak?.description ??
				"TimedCommitStatus evidence for the workflow-builder dev promotion gate.",
			tone: statusToTone(view.workflowBuilderSoak?.phase),
			href: view.workflowBuilderSoak?.url ?? null,
			linkLabel: "Open check",
		},
		{
			label: "dev-workflow-builder",
			value: view.devWorkflowBuilder?.liveImage
				? shortImage(view.devWorkflowBuilder.liveImage)
				: appStatusLabel(view.devWorkflowBuilder),
			description: "Managed dev spoke application after release pins, hydration, and promotion.",
			tone: appTone(view.devWorkflowBuilder),
			href: argoAppUrl("dev-workflow-builder"),
			linkLabel: "ArgoCD app",
		},
	]);

	async function refresh() {
		loading = true;
		try {
			const [metaRes, promoRes] = await Promise.all([
				fetch("/api/v1/gitops/deployment-metadata"),
				fetch("/api/v1/gitops/promotions"),
			]);
			if (!metaRes.ok) throw new Error(`metadata: ${metaRes.status} ${metaRes.statusText}`);
			if (!promoRes.ok) throw new Error(`promotions: ${promoRes.status} ${promoRes.statusText}`);
			metadata = (await metaRes.json()) as DeploymentMetadataResponse;
			promotions = (await promoRes.json()) as PromotionStrategiesResponse;
			requestError = null;
		} catch (err) {
			requestError = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		timer = setInterval(() => void refresh(), 15_000);
		clockTimer = setInterval(() => (now = Date.now()), 30_000);
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
		if (clockTimer) clearInterval(clockTimer);
	});

	function appTone(app: SystemApplicationStatus | null): SystemTone {
		if (!app) return "unknown";
		if (
			app.syncStatus === "OutOfSync" ||
			app.healthStatus === "Degraded" ||
			app.buildStatus === "False" ||
			app.buildReason === "Failed" ||
			app.buildReason === "Failure"
		) {
			return "failure";
		}
		if (
			app.syncStatus === "Synced" &&
			(app.healthStatus === "Healthy" || app.healthStatus === "Succeeded")
		) {
			return "healthy";
		}
		if (app.healthStatus === "Healthy" && !app.syncStatus) return "healthy";
		return "pending";
	}

	function buildTone(): SystemTone {
		const build = view.latestOuterLoopBuild;
		if (!build) return "unknown";
		if (
			build.status === "False" ||
			build.reason === "Failed" ||
			build.reason === "Failure"
		) {
			return "failure";
		}
		if (
			build.status === "True" ||
			build.reason === "Succeeded" ||
			build.reason === "Completed"
		) {
			return "healthy";
		}
		return "pending";
	}

	function liveTone(): SystemTone {
		const live = view.currentWorkflowBuilderLive;
		if (!live) return "unknown";
		if (live.ready === false) return "failure";
		if (live.ready === true) return "healthy";
		return "pending";
	}

	function statusToTone(status: string | null | undefined): SystemTone {
		if (!status) return "unknown";
		const value = status.toLowerCase();
		if (value.includes("fail") || value.includes("error")) return "failure";
		if (value.includes("success") || value.includes("succeed") || value.includes("healthy")) {
			return "healthy";
		}
		return "pending";
	}

	function combineTones(tones: SystemTone[]): SystemTone {
		if (tones.some((tone) => tone === "failure")) return "failure";
		if (tones.some((tone) => tone === "pending")) return "pending";
		if (tones.some((tone) => tone === "healthy")) return "healthy";
		return "unknown";
	}

	function toneVariant(tone: SystemTone): "secondary" | "destructive" | "outline" {
		if (tone === "healthy") return "secondary";
		if (tone === "failure") return "destructive";
		return "outline";
	}

	function toneLabel(tone: SystemTone): string {
		if (tone === "healthy") return "Healthy";
		if (tone === "failure") return "Needs attention";
		if (tone === "pending") return "In flight";
		return "No data";
	}

	function toneDotClass(tone: SystemTone): string {
		if (tone === "healthy") return "border-emerald-500 bg-emerald-500";
		if (tone === "failure") return "border-destructive bg-destructive";
		if (tone === "pending") return "border-amber-500 bg-amber-500";
		return "border-muted-foreground bg-background";
	}

	function repoBadgeClass(repo: TimelineStep["repo"]): string {
		if (repo === "workflow-builder") {
			return "border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-500/40 dark:bg-sky-950/30 dark:text-sky-200";
		}
		return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-200";
	}

	function appStatusLabel(app: SystemApplicationStatus | null): string {
		if (!app) return "No inventory";
		if (app.syncStatus && app.healthStatus) return `${app.syncStatus} / ${app.healthStatus}`;
		return app.healthStatus ?? app.syncStatus ?? app.driftStatus ?? "Unknown";
	}

	function argoAppUrl(name: string): string {
		return `${links.argoCdBase.replace(/\/+$/, "")}/applications/argocd/${encodeURIComponent(name)}`;
	}

	function ghcrPackageUrl(packageName: string): string {
		return `${links.ghcrOrg}/${encodeURIComponent(packageName)}`;
	}

	function buildReasonLabel(): string {
		const build = view.latestOuterLoopBuild;
		if (!build) return "No PipelineRun";
		return build.reason ?? build.status ?? "Unknown";
	}

	function shortDigest(digest: string): string {
		const [algorithm, value] = digest.split(":", 2);
		if (!algorithm || !value || value.length <= 16) return digest;
		return `${algorithm}:${value.slice(0, 12)}...${value.slice(-8)}`;
	}
</script>

<svelte:head>
	<title>GitOps System · Workflow Builder</title>
</svelte:head>

<div class="flex h-full flex-col overflow-hidden">
	<header class="border-b px-5 py-3">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex min-w-0 items-center gap-2">
				<Route class="size-5 shrink-0 text-muted-foreground" />
				<h1 class="truncate text-lg font-semibold">GitOps System</h1>
				<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">
					{view.currentEnvironment}
				</Badge>
				{#if view.stagingDormant}
					<Badge variant="outline" class="h-5 border-amber-300 bg-amber-50 px-1.5 text-[0.65rem] text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200">
						staging dormant
					</Badge>
				{/if}
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<a
					class="inline-flex items-center gap-1 text-[0.7rem] text-muted-foreground hover:text-foreground"
					href={stacksUrl}
					target="_blank"
					rel="noreferrer"
				>
					<GitBranch class="size-3" />
					stacks/main <span class="font-mono">{stacksShortSha}</span>
				</a>
				<span class="text-[0.7rem] text-muted-foreground">
					Updated {relativeTime(metadata.generatedAt, now)}
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

	{#if errors.length > 0}
		<div class="border-b bg-destructive/5 px-5 py-2 text-xs text-destructive">
			<div class="flex items-center gap-2">
				<AlertTriangle class="size-3.5 shrink-0" />
				<span class="truncate">{errors.join(" / ")}</span>
			</div>
		</div>
	{/if}

	<main class="flex-1 overflow-y-auto px-5 py-4">
		<div class="mx-auto flex max-w-[1420px] flex-col gap-4">
			<section class="grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
				<div class="rounded-lg border bg-card p-4">
					<div class="flex flex-wrap items-center justify-between gap-2">
						<div class="flex min-w-0 items-center gap-2">
							<Route class="size-4 text-muted-foreground" />
							<h2 class="truncate text-sm font-semibold">Release path</h2>
						</div>
						<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">
							source SHA -> image -> pins -> deploy
						</Badge>
					</div>

					<ol class="mt-4 space-y-3 border-l pl-4">
						{#each timelineSteps as item}
							<li class="relative pl-3">
								<span class="absolute -left-[1.66rem] flex size-7 items-center justify-center rounded-full border bg-background text-[0.7rem] font-semibold">
									{item.step}
								</span>
								<div class="grid gap-2 rounded-md border bg-background/60 p-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
									<div class="min-w-0">
										<div class="flex flex-wrap items-center gap-2">
											<span class="truncate text-sm font-medium">{item.title}</span>
											<Badge variant="outline" class="h-5 px-1.5 text-[0.62rem] {repoBadgeClass(item.repo)}">
												{item.repo}
											</Badge>
											<span class="inline-flex items-center gap-1 text-[0.68rem] text-muted-foreground">
												<span class="size-2 rounded-full border {toneDotClass(item.tone)}"></span>
												{toneLabel(item.tone)}
											</span>
										</div>
										<p class="mt-1 text-xs text-muted-foreground">{item.summary}</p>
									</div>
									<div class="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">
										<Badge variant={toneVariant(item.tone)} class="h-5 max-w-full px-1.5 text-[0.65rem]">
											<span class="truncate">{item.status}</span>
										</Badge>
										{#if item.href}
											<a
												class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
												href={item.href}
												target={item.href.startsWith("/") ? undefined : "_blank"}
												rel={item.href.startsWith("/") ? undefined : "noreferrer"}
											>
												{item.linkLabel}
												<ExternalLink class="size-3" />
											</a>
										{/if}
									</div>
								</div>
							</li>
						{/each}
					</ol>
				</div>

				<div class="rounded-lg border bg-card p-4">
					<div class="mb-3 flex items-center gap-2">
						<Server class="size-4 text-muted-foreground" />
						<h2 class="text-sm font-semibold">Image version</h2>
					</div>
					<div class="grid gap-2 text-xs">
						<div class="grid grid-cols-[8rem_1fr] gap-3 border-b pb-2">
							<span class="text-muted-foreground">Source</span>
							<span class="truncate font-mono">{currentSourceShaLabel}</span>
						</div>
						<div class="grid grid-cols-[8rem_1fr] gap-3 border-b pb-2">
							<span class="text-muted-foreground">Tag</span>
							<span class="truncate font-mono">{activePinTag}</span>
						</div>
						<div class="grid grid-cols-[8rem_1fr] gap-3 border-b pb-2">
							<span class="text-muted-foreground">Digest</span>
							<span class="truncate font-mono" title={activePinDigest ?? undefined}>{digestLabel}</span>
						</div>
						<div class="grid grid-cols-[8rem_1fr] gap-3 border-b pb-2">
							<span class="text-muted-foreground">Built</span>
							<span class="truncate">{buildFinishedLabel}</span>
						</div>
						<div class="grid grid-cols-[8rem_1fr] gap-3 border-b pb-2">
							<span class="text-muted-foreground">Pinned</span>
							<span class="truncate">{releasePinUpdatedLabel}</span>
						</div>
						<div class="grid grid-cols-[8rem_1fr] gap-3 border-b pb-2">
							<span class="text-muted-foreground">Ryzen</span>
							<span class="truncate">{appStatusLabel(view.ryzenWorkflowBuilder)}</span>
						</div>
						<div class="grid grid-cols-[8rem_1fr] gap-3 border-b pb-2">
							<span class="text-muted-foreground">Dev</span>
							<span class="truncate">{appStatusLabel(view.devWorkflowBuilder)}</span>
						</div>
						<div class="grid grid-cols-[8rem_1fr] gap-3">
							<span class="text-muted-foreground">Confirmed</span>
							<span class="truncate">{liveConfirmedLabel}</span>
						</div>
					</div>

					<div class="mt-4 rounded-md border border-dashed p-3 text-xs">
						<div class="flex items-center gap-2 font-medium">
							<Workflow class="size-3.5 text-muted-foreground" />
							Skaffold inner loop
						</div>
						<p class="mt-1 text-muted-foreground">
							For local iteration, source edits sync into the ryzen workflow-builder pod before a release commit exists. Durable dev rollout still follows the release path above.
						</p>
					</div>
				</div>
			</section>

			<Tabs bind:value={repoTab} class="gap-3">
				<div class="flex flex-wrap items-center justify-between gap-3">
					<TabsList class="h-8">
						<TabsTrigger value="workflow-builder" class="gap-1.5 text-xs">
							<Workflow class="size-3.5" />
							workflow-builder repo
						</TabsTrigger>
						<TabsTrigger value="stacks" class="gap-1.5 text-xs">
							<GitBranch class="size-3.5" />
							stacks repo
						</TabsTrigger>
					</TabsList>
					<span class="text-xs text-muted-foreground">
						Lane details
					</span>
				</div>

				<TabsContent value="workflow-builder" class="m-0">
					<section class="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
						<div class="rounded-lg border bg-card p-4">
							<div class="flex items-center justify-between gap-2">
								<div class="flex items-center gap-2">
									<Workflow class="size-4 text-muted-foreground" />
									<h2 class="text-sm font-semibold">App source lane</h2>
								</div>
								<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">
									inner + outer loop
								</Badge>
							</div>

							<div class="mt-4 grid gap-2 text-xs">
								<div class="flex items-center gap-2">
									<span class="w-28 text-muted-foreground">Local edit</span>
									<ArrowRight class="size-3.5 text-muted-foreground" />
									<span>Skaffold syncs files into ryzen</span>
								</div>
								<div class="flex items-center gap-2">
									<span class="w-28 text-muted-foreground">Push to main</span>
									<ArrowRight class="size-3.5 text-muted-foreground" />
									<span>GitHub webhook starts hub Tekton</span>
								</div>
								<div class="flex items-center gap-2">
									<span class="w-28 text-muted-foreground">Build output</span>
									<ArrowRight class="size-3.5 text-muted-foreground" />
									<span>GHCR image becomes the release artifact</span>
								</div>
								<div class="flex items-center gap-2">
									<span class="w-28 text-muted-foreground">Handoff</span>
									<ArrowRight class="size-3.5 text-muted-foreground" />
									<span>stacks records pins and deployment metadata</span>
								</div>
							</div>

							<div class="mt-4 flex flex-wrap gap-2">
								<Button variant="outline" size="sm" href={links.workflowBuilderRepo} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
									<GitBranch class="size-3.5" />
									GitHub
									<ExternalLink class="size-3" />
								</Button>
								<Button variant="outline" size="sm" href={ghcrPackageUrl("workflow-builder")} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
									<Package class="size-3.5" />
									GHCR
									<ExternalLink class="size-3" />
								</Button>
								{#if links.tektonBase}
									<Button variant="outline" size="sm" href={links.tektonBase} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
										<TektonLogo class="size-3.5" />
										Tekton
										<ExternalLink class="size-3" />
									</Button>
								{/if}
							</div>
						</div>

						<div class="rounded-lg border bg-card p-4">
							<div class="mb-2 flex items-center gap-2">
								<Hammer class="size-4 text-muted-foreground" />
								<h2 class="text-sm font-semibold">Evidence</h2>
							</div>
							<div class="divide-y">
								{#each workflowEvidence as row}
									<details class="group py-3">
										<summary class="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
											<div class="min-w-0">
												<div class="text-xs font-medium">{row.label}</div>
												<div class="truncate font-mono text-xs text-muted-foreground" title={row.value}>
													{row.value}
												</div>
											</div>
											<div class="flex items-center gap-2">
												<Badge variant={toneVariant(row.tone)} class="h-5 px-1.5 text-[0.65rem]">
													{toneLabel(row.tone)}
												</Badge>
												<span class="text-[0.65rem] text-muted-foreground group-open:hidden">details</span>
												<span class="hidden text-[0.65rem] text-muted-foreground group-open:inline">hide</span>
											</div>
										</summary>
										<div class="mt-2 text-xs text-muted-foreground">
											{row.description}
											{#if row.href}
												<a
													class="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
													href={row.href}
													target={row.href.startsWith("/") ? undefined : "_blank"}
													rel={row.href.startsWith("/") ? undefined : "noreferrer"}
												>
													{row.linkLabel}
													<ExternalLink class="size-3" />
												</a>
											{/if}
										</div>
									</details>
								{/each}
							</div>
						</div>
					</section>
				</TabsContent>

				<TabsContent value="stacks" class="m-0">
					<section class="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
						<div class="rounded-lg border bg-card p-4">
							<div class="flex items-center justify-between gap-2">
								<div class="flex items-center gap-2">
									<GitBranch class="size-4 text-muted-foreground" />
									<h2 class="text-sm font-semibold">Infra and manifest lane</h2>
								</div>
								<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">
									two active targets
								</Badge>
							</div>

							<div class="mt-4 space-y-4 text-xs">
								<div>
									<div class="mb-1 flex items-center gap-2 font-medium">
										<ArgoCDLogo class="size-3.5" />
										Ryzen direct-main
									</div>
									<p class="text-muted-foreground">
										Ryzen is autonomous: root-ryzen reads stacks main directly and applies overlays/ryzen. It is not promoted through env/spokes-dev.
									</p>
								</div>
								<div>
									<div class="mb-1 flex items-center gap-2 font-medium">
										<TektonLogo class="size-3.5" />
										Dev outer loop
									</div>
									<p class="text-muted-foreground">
										Release pins render the dev overlay, Source Hydrator writes env/spokes-dev-next, and GitOps Promoter advances env/spokes-dev.
									</p>
								</div>
								{#if view.stagingDormant}
									<div class="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-100">
										Staging is retained as dormant re-enable context and is not drawn as an active lane.
									</div>
								{/if}
							</div>

							<div class="mt-4 flex flex-wrap gap-2">
								<Button variant="outline" size="sm" href={links.stacksRepo} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
									<GitBranch class="size-3.5" />
									GitHub
									<ExternalLink class="size-3" />
								</Button>
								<Button variant="outline" size="sm" href={releasePinsUrl} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
									<GitCommit class="size-3.5" />
									Release pins
									<ExternalLink class="size-3" />
								</Button>
								<Button variant="outline" size="sm" href={links.argoCdBase} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
									<ArgoCDLogo class="size-3.5" />
									ArgoCD
									<ExternalLink class="size-3" />
								</Button>
							</div>
						</div>

						<div class="rounded-lg border bg-card p-4">
							<div class="mb-2 flex items-center gap-2">
								<Database class="size-4 text-muted-foreground" />
								<h2 class="text-sm font-semibold">Evidence</h2>
							</div>
							<div class="divide-y">
								{#each stacksEvidence as row}
									<details class="group py-3">
										<summary class="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
											<div class="min-w-0">
												<div class="text-xs font-medium">{row.label}</div>
												<div class="truncate font-mono text-xs text-muted-foreground" title={row.value}>
													{row.value}
												</div>
											</div>
											<div class="flex items-center gap-2">
												<Badge variant={toneVariant(row.tone)} class="h-5 px-1.5 text-[0.65rem]">
													{toneLabel(row.tone)}
												</Badge>
												<span class="text-[0.65rem] text-muted-foreground group-open:hidden">details</span>
												<span class="hidden text-[0.65rem] text-muted-foreground group-open:inline">hide</span>
											</div>
										</summary>
										<div class="mt-2 text-xs text-muted-foreground">
											{row.description}
											{#if row.href}
												<a
													class="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
													href={row.href}
													target={row.href.startsWith("/") ? undefined : "_blank"}
													rel={row.href.startsWith("/") ? undefined : "noreferrer"}
												>
													{row.linkLabel}
													<ExternalLink class="size-3" />
												</a>
											{/if}
										</div>
									</details>
								{/each}
							</div>
						</div>
					</section>
				</TabsContent>
			</Tabs>

			<details class="rounded-lg border bg-card p-4">
				<summary class="flex cursor-pointer list-none items-center justify-between gap-3">
					<div class="flex items-center gap-2">
						<ExternalLink class="size-4 text-muted-foreground" />
						<h2 class="text-sm font-semibold">Operator links</h2>
					</div>
					<span class="text-xs text-muted-foreground">show links</span>
				</summary>
				<div class="mt-3 flex flex-wrap gap-2">
					<Button variant="outline" size="sm" href={links.workflowBuilderRepo} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
						<GitBranch class="size-3.5" />
						Workflow Builder GitHub
						<ExternalLink class="size-3" />
					</Button>
					<Button variant="outline" size="sm" href={links.stacksRepo} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
						<GitBranch class="size-3.5" />
						Stacks GitHub
						<ExternalLink class="size-3" />
					</Button>
					<Button variant="outline" size="sm" href={links.ghcrPackages} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
						<Package class="size-3.5" />
						GHCR packages
						<ExternalLink class="size-3" />
					</Button>
					<Button variant="outline" size="sm" href={ghcrPackageUrl("workflow-builder")} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
						<Package class="size-3.5" />
						workflow-builder image
						<ExternalLink class="size-3" />
					</Button>
					{#if links.tektonBase}
						<Button variant="outline" size="sm" href={links.tektonBase} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
							<TektonLogo class="size-3.5" />
							Tekton Dashboard
							<ExternalLink class="size-3" />
						</Button>
					{/if}
					<Button variant="outline" size="sm" href={links.argoCdBase} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
						<ArgoCDLogo class="size-3.5" />
						ArgoCD
						<ExternalLink class="size-3" />
					</Button>
					<Button variant="outline" size="sm" href={links.workflowBuilderRyzen} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
						<Server class="size-3.5" />
						workflow-builder ryzen
						<ExternalLink class="size-3" />
					</Button>
					<Button variant="outline" size="sm" href={links.workflowBuilderDev} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
						<Server class="size-3.5" />
						workflow-builder dev
						<ExternalLink class="size-3" />
					</Button>
					<Button variant="outline" size="sm" href={links.deploymentInventory} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
						<Database class="size-3.5" />
						Deployment inventory
						<ExternalLink class="size-3" />
					</Button>
					<Button variant="outline" size="sm" href={releasePinsUrl} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
						<GitCommit class="size-3.5" />
						Release pins
						<ExternalLink class="size-3" />
					</Button>
					<Button variant="outline" size="sm" href={ryzenOverlayUrl} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
						<GitBranch class="size-3.5" />
						overlays/ryzen
						<ExternalLink class="size-3" />
					</Button>
					<Button variant="outline" size="sm" href={devOverlayUrl} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
						<GitBranch class="size-3.5" />
						dev overlay
						<ExternalLink class="size-3" />
					</Button>
					{#if devBranchUrl}
						<Button variant="outline" size="sm" href={devBranchUrl} target="_blank" rel="noreferrer" class="h-7 gap-1.5 text-xs">
							<GitBranch class="size-3.5" />
							env/spokes-dev
							<ExternalLink class="size-3" />
						</Button>
					{/if}
					<Button variant="outline" size="sm" href="/admin/deployments" class="h-7 gap-1.5 text-xs">
						<Database class="size-3.5" />
						Admin Deployments
					</Button>
				</div>
			</details>

			<footer class="flex flex-wrap items-center gap-x-4 gap-y-1 pb-2 text-[0.7rem] text-muted-foreground">
				<div class="flex items-center gap-1.5">
					<Database class="size-3" />
					<span>Hub inventory</span>
					{#if metadata.inventory.sourceUrl}
						<span class="max-w-[28rem] truncate font-mono" title={metadata.inventory.sourceUrl}>
							{metadata.inventory.sourceUrl}
						</span>
					{:else}
						<span>(no WORKFLOW_BUILDER_GITOPS_INVENTORY_URL set)</span>
					{/if}
				</div>
				<div class="flex items-center gap-1.5">
					<Clock3 class="size-3" />
					<span>
						{metadata.inventory.data
							? `hub generated ${relativeTime(metadata.inventory.data.generatedAt, now)}`
							: "no hub data"}
					</span>
				</div>
				<div class="flex items-center gap-1.5">
					<Hammer class="size-3" />
					<span>
						latest build
						{view.latestOuterLoopBuild?.finishedAt
							? relativeTime(view.latestOuterLoopBuild.finishedAt, now)
							: "unknown"}
					</span>
				</div>
				{#if view.stagingDormant}
					<div class="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
						<CheckCircle2 class="size-3" />
						<span>Staging is retained for re-enable, not drawn as an active lane.</span>
					</div>
				{/if}
			</footer>
		</div>
	</main>
</div>

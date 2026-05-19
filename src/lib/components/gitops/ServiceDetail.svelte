<script lang="ts">
	import {
		CheckCircle2,
		CircleAlert,
		Clock3,
		ExternalLink,
		FileCode,
		GitBranch,
		GitCommit,
		Hammer,
		Info,
		Package,
	} from "@lucide/svelte";

	import CopyButton from "$lib/components/gitops/CopyButton.svelte";
	import EnvCard from "$lib/components/gitops/EnvCard.svelte";
	import ArgoCDLogo from "$lib/components/gitops/icons/ArgoCDLogo.svelte";
	import HeadlampLogo from "$lib/components/gitops/icons/HeadlampLogo.svelte";
	import TektonLogo from "$lib/components/gitops/icons/TektonLogo.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { argoGates, releasePrGate, type GateState } from "$lib/gitops/gates";
	import { headlampResourceUrl, type HeadlampCluster } from "$lib/headlamp/links";
	import {
		ENVIRONMENTS,
		summarizeRow,
		type EnvName,
		type ServiceRow,
	} from "$lib/gitops/service-matrix";
	import type {
		DesiredImageMetadata,
		GitCommitMetadata,
	} from "$lib/types/deployment-metadata";
	import {
		formatDurationMs,
		relativeTime,
		shortSha,
		statusVariant,
	} from "$lib/utils/gitops-display";

	import type { GitopsPageLinks } from "../../../routes/(admin)/admin/gitops/+page.server";

	type Props = {
		row: ServiceRow;
		tektonBase?: string | null;
		envsVisible?: Record<EnvName, boolean>;
		links: GitopsPageLinks;
		desiredImages: DesiredImageMetadata[];
		// Clock tick. Passing this in lets the parent drive "refresh relativeTime"
		// without this component owning its own interval.
		now?: number;
	};

	let {
		row,
		tektonBase = null,
		envsVisible = { ryzen: false, dev: true, staging: true },
		links,
		desiredImages,
		now,
	}: Props = $props();

	// Tick-aware wrapper so the template re-runs when `now` changes.
	const _rt = $derived((iso: string | null | undefined) => relativeTime(iso, now));

	const summary = $derived(summarizeRow(row));

	const specialCaseLabel = $derived.by(() => {
		switch (row.specialCase) {
			case "sandbox-only":
				return "runtime-launched sandbox";
			case "ryzen-missing-pin":
				return "no ryzen kustomization pin";
			case "ryzen-only":
				return "ryzen-only (no dev/staging promotion)";
			default:
				return null;
		}
	});

	const visibleEnvs = $derived(
		(ENVIRONMENTS as readonly EnvName[]).filter((env) => envsVisible[env]),
	);

	const prGate = $derived(releasePrGate(row.envs.ryzen, row.envs.dev));
	const argoGate = $derived(argoGates(row.envs.dev, row.envs.staging));

	const gateSummary = $derived.by(() => {
		const gates: Array<{ key: string; label: string; state: GateState }> = [];
		if (envsVisible.ryzen && envsVisible.dev) {
			gates.push({ key: "ryzen-dev", label: "ryzen → dev (release PR)", state: prGate });
		}
		if (envsVisible.dev && envsVisible.staging) {
			gates.push({ key: "dev-staging", label: "dev → staging (Promoter gates)", state: argoGate });
		}
		return gates;
	});

	// One representative build surface: prefer dev, then staging, then ryzen.
	const buildCell = $derived.by(() => {
		for (const env of ["dev", "staging", "ryzen"] as const) {
			const cell = row.envs[env];
			if (cell?.buildPipelineRun) return { env, cell };
		}
		return null;
	});
	const buildDuration = $derived.by(() => {
		const c = buildCell?.cell;
		if (!c?.buildStartedAt || !c?.buildFinishedAt) return null;
		return new Date(c.buildFinishedAt).getTime() - new Date(c.buildStartedAt).getTime();
	});
	const tektonUrl = $derived.by(() => {
		const name = buildCell?.cell.buildPipelineRun;
		if (!name || !tektonBase) return null;
		return `${tektonBase.replace(/\/+$/, "")}/#/namespaces/tekton-pipelines/pipelineruns/${encodeURIComponent(name)}`;
	});

	const statusBadge = $derived.by(() => {
		if (summary.overall === "healthy") return { label: "Healthy", variant: "secondary" as const };
		if (summary.overall === "drift") return { label: "Rollout in progress", variant: "outline" as const };
		if (summary.overall === "degraded") return { label: "Needs attention", variant: "destructive" as const };
		if (summary.overall === "empty") return { label: "No data", variant: "outline" as const };
		return { label: "Unknown", variant: "outline" as const };
	});

	const StatusIcon = $derived(
		summary.overall === "healthy"
			? CheckCircle2
			: summary.overall === "drift"
				? Clock3
				: summary.overall === "degraded"
					? CircleAlert
					: Info,
	);

	const StatusIconColor = $derived(
		summary.overall === "healthy"
			? "text-emerald-500"
			: summary.overall === "drift"
				? "text-amber-500"
				: summary.overall === "degraded"
					? "text-destructive"
					: "text-muted-foreground",
	);

	const primarySha = $derived(
		row.envs.dev?.commitSha ??
			row.envs.staging?.commitSha ??
			row.envs.ryzen?.commitSha ??
			null,
	);
	const commitUrl = $derived(
		primarySha ? `${links.workflowBuilderRepo}/commit/${primarySha}` : null,
	);

	// Link out to the ArgoCD Application that actually serves this env.
	function argoAppUrlFor(env: EnvName): string | null {
		const appName = row.envs[env]?.applicationName;
		if (!appName) return null;
		return `${links.argoCdBase.replace(/\/+$/, "")}/applications/argocd/${encodeURIComponent(appName)}`;
	}
	const argoAppUrls = $derived.by(() => {
		const out: Array<{ env: EnvName; url: string }> = [];
		for (const env of ENVIRONMENTS) {
			const url = argoAppUrlFor(env);
			if (url) out.push({ env, url });
		}
		return out;
	});
	const headlampDeploymentUrls = $derived.by(() => {
		if (row.specialCase === "sandbox-only") return [];
		const out: Array<{ env: EnvName; url: string }> = [];
		for (const env of visibleEnvs) {
			const cell = row.envs[env];
			if (!cell) continue;
			const url = headlampResourceUrl({
				headlampBase: links.headlampBase,
				cluster: env as HeadlampCluster,
				kind: "Deployment",
				namespace: "workflow-builder",
				name: row.service,
			});
			if (!url) continue;
			out.push({
				env,
				url,
			});
		}
		return out;
	});

	const releasePinsUrl = $derived(
		`${links.stacksRepo}/blob/main/${links.releasePinsPath}#:~:text=${encodeURIComponent(row.service)}`,
	);

	function envBranchUrl(env: EnvName): string {
		return `${links.stacksRepo}/tree/env/spokes-${env}`;
	}

	const ghcrUrl = $derived.by(() => {
		const images = [row.envs.dev, row.envs.staging, row.envs.ryzen]
			.map((c) => c?.desiredImage ?? c?.liveImage)
			.filter(Boolean) as string[];
		const ghcrImage = images.find((i) => i.startsWith("ghcr.io/pittampalliorg/"));
		if (!ghcrImage) return null;
		// ghcr.io/pittampalliorg/<service>:<tag> → the GHCR package URL
		const pkg = ghcrImage.split(":")[0].split("/").pop();
		if (!pkg) return null;
		return `${links.ghcrOrg}/${pkg}`;
	});

	// Commit subject from the existing server-side desiredImages cache.
	const pinCommit: GitCommitMetadata | null = $derived(
		desiredImages.find((img) => img.name === row.service)?.commit ?? null,
	);
</script>

<div class="flex h-full flex-col overflow-y-auto">
	<header class="border-b bg-card/40 px-6 py-4">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div class="flex items-center gap-2">
				<Package class="size-5 text-muted-foreground" />
				<h2 class="text-lg font-semibold">{row.service}</h2>
				{#if specialCaseLabel}
					<Badge variant="outline" class="h-5 px-1.5 text-[0.65rem]">
						{specialCaseLabel}
					</Badge>
				{/if}
			</div>
			<div class="flex items-center gap-2">
				<StatusIcon class={`size-4 ${StatusIconColor}`} />
				<Badge variant={statusBadge.variant} class="h-5 px-2 text-[0.7rem]">
					{statusBadge.label}
				</Badge>
				{#if summary.updatedAt}
					<span class="text-[0.7rem] text-muted-foreground">
						updated {_rt(summary.updatedAt)}
					</span>
				{/if}
			</div>
		</div>
	</header>

	<div class="flex-1 space-y-5 p-6">
		{#if pinCommit}
			<section class="rounded-lg border bg-muted/30 p-3 text-xs">
				<div class="mb-1 flex items-center gap-2 text-[0.65rem] uppercase tracking-wide text-muted-foreground">
					<GitCommit class="size-3" />
					Release-pin commit
				</div>
				<div class="flex flex-wrap items-baseline gap-x-2">
					<a
						class="font-mono text-primary hover:underline"
						href={pinCommit.url}
						target="_blank"
						rel="noreferrer"
					>
						{pinCommit.shortSha}
					</a>
					<CopyButton value={pinCommit.sha} label="Copy commit SHA" />
					<span class="font-medium">{pinCommit.message ?? "(no subject)"}</span>
					{#if pinCommit.authorName}
						<span class="text-muted-foreground">· {pinCommit.authorName}</span>
					{/if}
					{#if pinCommit.committedAt}
						<span class="text-muted-foreground">· {_rt(pinCommit.committedAt)}</span>
					{/if}
				</div>
			</section>
		{/if}

		<section class="space-y-2">
			<div class="flex items-center justify-between">
				<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Environments
				</h3>
			</div>
			{#if visibleEnvs.length > 0}
				<div
					class="grid gap-3"
					class:sm:grid-cols-2={visibleEnvs.length >= 2}
					class:lg:grid-cols-3={visibleEnvs.length === 3}
				>
					{#each visibleEnvs as env (env)}
						<EnvCard {env} cell={row.envs[env]} specialCase={row.specialCase} />
					{/each}
				</div>
			{:else}
				<div class="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
					All environment columns are toggled off. Enable one from the filter bar to see details.
				</div>
			{/if}
		</section>

		{#if gateSummary.length > 0}
			<section class="space-y-2">
				<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Promotion gates
				</h3>
				<ul class="divide-y rounded-lg border">
					{#each gateSummary as gate (gate.key)}
						{@const isPassed = gate.state.status === "passed"}
						{@const isFailed = gate.state.status === "failed"}
						<li class="flex items-center justify-between gap-3 px-3 py-2 text-xs">
							<div class="flex items-center gap-2">
								{#if isPassed}
									<CheckCircle2 class="size-3.5 text-emerald-500" />
								{:else if isFailed}
									<CircleAlert class="size-3.5 text-destructive" />
								{:else}
									<Clock3 class="size-3.5 text-muted-foreground" />
								{/if}
								<span class="font-medium">{gate.label}</span>
							</div>
							<span
								class="text-right {isPassed
									? 'text-emerald-600 dark:text-emerald-400'
									: isFailed
										? 'text-destructive'
										: 'text-muted-foreground'}"
								title={gate.state.tooltip}
							>
								{gate.state.label}
							</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		{#if buildCell}
			<section class="space-y-2">
				<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Latest build
				</h3>
				<div class="rounded-lg border p-3 text-xs">
					<div class="flex flex-wrap items-center gap-2">
						<Hammer class="size-4 text-muted-foreground" />
						<Badge
							variant={statusVariant(buildCell.cell.buildStatus ?? buildCell.cell.buildReason)}
							class="h-5 px-1.5 text-[0.65rem]"
						>
							{buildCell.cell.buildReason ?? buildCell.cell.buildStatus ?? "Unknown"}
						</Badge>
						<span class="text-muted-foreground">on</span>
						<span class="font-mono">{buildCell.env}</span>
						{#if buildCell.cell.buildFinishedAt}
							<span class="text-muted-foreground">
								· finished {_rt(buildCell.cell.buildFinishedAt)}
							</span>
						{/if}
						{#if buildDuration != null}
							<span class="text-muted-foreground">· took {formatDurationMs(buildDuration)}</span>
						{/if}
					</div>
					<div class="mt-1 flex items-center gap-2">
						<TektonLogo class="size-3.5" />
						<span class="text-muted-foreground">PipelineRun</span>
						{#if tektonUrl}
							<a
								class="truncate font-mono text-primary hover:underline"
								href={tektonUrl}
								target="_blank"
								rel="noreferrer"
							>
								{buildCell.cell.buildPipelineRun}
								<ExternalLink class="ml-0.5 inline size-3" />
							</a>
						{:else}
							<span class="truncate font-mono">{buildCell.cell.buildPipelineRun}</span>
						{/if}
						<CopyButton
							value={buildCell.cell.buildPipelineRun}
							label="Copy PipelineRun name"
						/>
					</div>
				</div>
			</section>
		{/if}

		<section class="space-y-2">
			<h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
				Deep links
			</h3>
			<div class="flex flex-wrap gap-2">
				{#if commitUrl}
					<Button
						variant="outline"
						size="sm"
						href={commitUrl}
						class="h-7 gap-1.5 text-xs"
						target="_blank"
						rel="noreferrer"
					>
						<GitCommit class="size-3 text-muted-foreground/60" />
						<span class="font-mono">{shortSha(primarySha)}</span>
						<ExternalLink class="size-3" />
					</Button>
				{/if}
				{#each argoAppUrls as link (link.env)}
					<Button
						variant="outline"
						size="sm"
						href={link.url}
						class="h-7 gap-1.5 text-xs"
						target="_blank"
						rel="noreferrer"
						title={`Open ArgoCD app for ${link.env}`}
					>
						<ArgoCDLogo class="size-3.5" />
						ArgoCD · {link.env}
						<ExternalLink class="size-3" />
					</Button>
				{/each}
				{#each headlampDeploymentUrls as link (link.env)}
					<Button
						variant="outline"
						size="sm"
						href={link.url}
						class="h-7 gap-1.5 text-xs"
						target="_blank"
						rel="noreferrer"
						title={`Open ${row.service} Deployment in Headlamp for ${link.env}`}
					>
						<HeadlampLogo class="size-3.5" />
						Headlamp · {link.env}
						<ExternalLink class="size-3" />
					</Button>
				{/each}
				<Button
					variant="outline"
					size="sm"
					href={releasePinsUrl}
					class="h-7 gap-1.5 text-xs"
					target="_blank"
					rel="noreferrer"
					title="Jump to the release-pins YAML on GitHub (highlights this service)"
				>
					<FileCode class="size-3 text-muted-foreground/60" />
					Release pins
					<ExternalLink class="size-3" />
				</Button>
				{#if envsVisible.dev}
					<Button
						variant="outline"
						size="sm"
						href={envBranchUrl("dev")}
						class="h-7 gap-1.5 text-xs"
						target="_blank"
						rel="noreferrer"
					title="Browse the hydrated env/spokes-dev branch"
				>
						<GitBranch class="size-3 text-muted-foreground/60" />
						env/spokes-dev
						<ExternalLink class="size-3" />
					</Button>
				{/if}
				{#if envsVisible.staging}
					<Button
						variant="outline"
						size="sm"
						href={envBranchUrl("staging")}
						class="h-7 gap-1.5 text-xs"
						target="_blank"
						rel="noreferrer"
					title="Browse the hydrated env/spokes-staging branch"
				>
						<GitBranch class="size-3 text-muted-foreground/60" />
						env/spokes-staging
						<ExternalLink class="size-3" />
					</Button>
				{/if}
				{#if ghcrUrl}
					<Button
						variant="outline"
						size="sm"
						href={ghcrUrl}
						class="h-7 gap-1.5 text-xs"
						target="_blank"
						rel="noreferrer"
					title="View the image on GitHub Container Registry"
				>
						<Package class="size-3 text-muted-foreground/60" />
						GHCR
						<ExternalLink class="size-3" />
					</Button>
				{/if}
			</div>
		</section>
	</div>
</div>

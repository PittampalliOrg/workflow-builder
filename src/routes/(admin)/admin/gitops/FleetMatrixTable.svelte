<script lang="ts">
	import {
		AlertTriangle,
		ArrowUpRight,
		CheckCircle2,
		ChevronRight,
		CircleSlash,
		ExternalLink,
		GitCommit,
		Loader2,
		Maximize2,
	} from "@lucide/svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { Button } from "$lib/components/ui/button";
	import { Skeleton } from "$lib/components/ui/skeleton";
	import {
		buildLineage,
		compactAgeLabel,
		type FleetServiceDrift,
	} from "$lib/gitops/fleet-drift-view";
	import type { GitopsPageLinks } from "$lib/gitops/links";
	import {
		summarizeRow,
		type EnvCell,
		type EnvName,
		type ServiceRow,
	} from "$lib/gitops/service-matrix";
	import {
		relativeTime,
		shortSha,
		shortTag,
		tektonPipelineRunUrl,
	} from "$lib/utils/gitops-display";

	import LineageStepper from "./LineageStepper.svelte";

	type Props = {
		rows: ServiceRow[];
		drift: Map<string, FleetServiceDrift>;
		/** True while the fleet-drift extras query has not resolved yet. */
		extrasLoading: boolean;
		envsVisible: Record<EnvName, boolean>;
		links: GitopsPageLinks;
		tektonBase: string | null;
		now: number;
		onOpenDetail: (service: string) => void;
	};

	let {
		rows,
		drift,
		extrasLoading,
		envsVisible,
		links,
		tektonBase,
		now,
		onOpenDetail,
	}: Props = $props();

	let expandedService = $state<string | null>(null);

	const visibleEnvs = $derived(
		(["dev", "staging", "ryzen"] as const).filter((env) => envsVisible[env]),
	);
	const columnCount = $derived(4 + visibleEnvs.length);

	function toggleExpanded(service: string) {
		expandedService = expandedService === service ? null : service;
	}

	type CellTone = "ok" | "drift" | "bad" | "muted";

	function envCellTone(cell: EnvCell | null): CellTone {
		if (!cell) return "muted";
		if (
			cell.healthStatus === "Degraded" ||
			cell.buildReason === "Failed" ||
			cell.buildReason === "Failure"
		) {
			return "bad";
		}
		if (cell.syncStatus === "OutOfSync" || cell.driftStatus === "pending_rollout") {
			return "drift";
		}
		if (cell.syncStatus === "Synced" || cell.driftStatus === "in_sync") return "ok";
		return "muted";
	}

	function envCellTitle(env: EnvName, cell: EnvCell | null): string {
		if (!cell) return `${env}: no data`;
		const bits = [
			cell.tag ? `tag ${cell.tag}` : null,
			cell.syncStatus ? `sync ${cell.syncStatus}` : null,
			cell.healthStatus ? `health ${cell.healthStatus}` : null,
			cell.driftStatus ? `drift ${cell.driftStatus}` : null,
		].filter(Boolean);
		return `${env}: ${bits.join(" · ") || "no status"}`;
	}

	const toneDot: Record<CellTone, string> = {
		ok: "bg-emerald-500",
		drift: "bg-amber-500",
		bad: "bg-destructive",
		muted: "bg-muted-foreground/30",
	};

	function rowIcon(overall: ReturnType<typeof summarizeRow>["overall"]) {
		if (overall === "healthy") return CheckCircle2;
		if (overall === "drift" || overall === "degraded") return AlertTriangle;
		return CircleSlash;
	}

	function rowIconColor(overall: ReturnType<typeof summarizeRow>["overall"]): string {
		if (overall === "healthy") return "text-emerald-500";
		if (overall === "drift") return "text-amber-500";
		if (overall === "degraded") return "text-destructive";
		return "text-muted-foreground/40";
	}

	const releasePinsUrl = (service: string) =>
		`${links.stacksRepo}/blob/main/${links.releasePinsPath}#:~:text=${encodeURIComponent(service)}`;
</script>

<div class="h-full overflow-auto">
	{#if rows.length === 0}
		<div class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
			No services match the current filter.
		</div>
	{:else}
		<table class="w-full min-w-[58rem] border-separate border-spacing-0 text-sm">
			<thead>
				<tr
					class="text-left text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground"
				>
					<th class="sticky top-0 z-10 border-b bg-background px-3 py-2 font-semibold">Service</th>
					{#each visibleEnvs as env (env)}
						<th class="sticky top-0 z-10 border-b bg-background px-3 py-2 font-semibold">{env}</th>
					{/each}
					<th class="sticky top-0 z-10 border-b bg-background px-3 py-2 font-semibold">
						Newest built
					</th>
					<th class="sticky top-0 z-10 border-b bg-background px-3 py-2 font-semibold">Pin age</th>
					<th class="sticky top-0 z-10 border-b bg-background px-3 py-2 font-semibold">vs main</th>
				</tr>
			</thead>
			<tbody>
				{#each rows as row (row.service)}
					{@const summary = summarizeRow(row)}
					{@const RowIcon = rowIcon(summary.overall)}
					{@const serviceDrift = drift.get(row.service) ?? null}
					{@const expanded = expandedService === row.service}
					{@const tektonUrl = tektonPipelineRunUrl(
						tektonBase,
						serviceDrift?.inFlightPipelineRun,
					)}
					<tr
						class="group transition-colors hover:bg-muted/50 {expanded ? 'bg-muted/40' : ''}"
					>
						<td class="border-b p-0">
							<button
								type="button"
								class="flex w-full items-center gap-2 px-3 py-2 text-left"
								aria-expanded={expanded}
								aria-label={`Toggle ${row.service} lineage`}
								onclick={() => toggleExpanded(row.service)}
							>
								<ChevronRight
									class="size-3.5 shrink-0 text-muted-foreground transition-transform {expanded
										? 'rotate-90'
										: ''}"
								/>
								<RowIcon class="size-3.5 shrink-0 {rowIconColor(summary.overall)}" />
								<span class="truncate font-medium">{row.service}</span>
								{#if row.specialCase === "sandbox-only"}
									<Badge variant="outline" class="h-4 px-1 text-[0.6rem]">sandbox</Badge>
								{/if}
							</button>
						</td>
						{#each visibleEnvs as env (env)}
							{@const cell = row.envs[env]}
							{@const tone = envCellTone(cell)}
							<td class="border-b px-3 py-2" title={envCellTitle(env, cell)}>
								{#if cell}
									<span class="inline-flex items-center gap-1.5">
										<span
											class="size-1.5 shrink-0 rounded-full {toneDot[tone]}"
											aria-hidden="true"
										></span>
										<span class="font-mono text-xs">{shortTag(cell.tag)}</span>
									</span>
								{:else}
									<span class="text-muted-foreground/50">—</span>
								{/if}
							</td>
						{/each}
						<td class="border-b px-3 py-2">
							{#if extrasLoading && !serviceDrift?.newestBuiltTag}
								<Skeleton class="h-4 w-20" />
							{:else if serviceDrift?.inFlightPipelineRun}
								<span
									class="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400"
									title={`Build in flight: ${serviceDrift.inFlightPipelineRun}`}
								>
									<Loader2 class="size-3.5 motion-safe:animate-spin" />
									<span class="font-mono text-xs">
										{shortTag(serviceDrift.newestBuiltTag) === "—"
											? "building"
											: shortTag(serviceDrift.newestBuiltTag)}
									</span>
								</span>
							{:else if serviceDrift?.newestBuiltTag}
								<span
									class="font-mono text-xs"
									title={serviceDrift.newestBuiltAt
										? `Pinned ${relativeTime(serviceDrift.newestBuiltAt, now)}`
										: undefined}
								>
									{shortTag(serviceDrift.newestBuiltTag)}
								</span>
							{:else}
								<span class="text-muted-foreground/50">—</span>
							{/if}
						</td>
						<td class="border-b px-3 py-2">
							{#if extrasLoading && serviceDrift?.pinAgeMs == null}
								<Skeleton class="h-4 w-10" />
							{:else if serviceDrift?.pinAgeMs != null}
								<span
									class="tabular-nums {serviceDrift.pinStale
										? 'font-medium text-amber-600 dark:text-amber-400'
										: 'text-muted-foreground'}"
									title={serviceDrift.pinUpdatedAt
										? `Pin last bumped ${relativeTime(serviceDrift.pinUpdatedAt, now)}`
										: undefined}
								>
									{compactAgeLabel(serviceDrift.pinAgeMs)}
									{#if serviceDrift.pinStale}
										<AlertTriangle class="ml-0.5 inline size-3" />
									{/if}
								</span>
							{:else}
								<span class="text-muted-foreground/50">—</span>
							{/if}
						</td>
						<td class="border-b px-3 py-2">
							{#if extrasLoading && serviceDrift?.pinVsMain === "unknown"}
								<Skeleton class="h-4 w-14" />
							{:else if serviceDrift?.pinVsMain === "in-sync"}
								<span class="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
									<CheckCircle2 class="size-3.5" />
									<span class="text-xs">at HEAD</span>
								</span>
							{:else if serviceDrift?.pinVsMain === "behind-main"}
								<a
									class="inline-flex items-center gap-1 text-amber-600 hover:underline dark:text-amber-400"
									href={serviceDrift.compareUrl ?? `${links.workflowBuilderRepo}/commits/main`}
									target="_blank"
									rel="noreferrer"
									title="Pin is not workflow-builder main HEAD — open compare"
								>
									<ArrowUpRight class="size-3.5" />
									<span class="text-xs">behind</span>
								</a>
							{:else}
								<span class="text-muted-foreground/50">—</span>
							{/if}
						</td>
					</tr>
					{#if expanded}
						<tr>
							<td colspan={columnCount} class="border-b bg-muted/20 px-3 py-0">
								<div class="flex flex-col gap-3 py-3 pl-8">
									<div class="overflow-x-auto pb-1">
										<LineageStepper
											steps={buildLineage(row, serviceDrift, visibleEnvs)}
											{now}
										/>
									</div>
									<div class="flex flex-wrap items-center gap-2">
										{#if serviceDrift?.pinSha}
											<Button
												variant="outline"
												size="sm"
												href={`${links.workflowBuilderRepo}/commit/${serviceDrift.pinSha}`}
												class="h-6 gap-1 px-2 text-[0.7rem]"
												target="_blank"
												rel="noreferrer"
											>
												<GitCommit class="size-3 text-muted-foreground/60" />
												<span class="font-mono">{shortSha(serviceDrift.pinSha)}</span>
											</Button>
										{/if}
										{#if serviceDrift?.compareUrl}
											<Button
												variant="outline"
												size="sm"
												href={serviceDrift.compareUrl}
												class="h-6 gap-1 px-2 text-[0.7rem]"
												target="_blank"
												rel="noreferrer"
											>
												<ArrowUpRight class="size-3 text-muted-foreground/60" />
												Compare to main
											</Button>
										{/if}
										{#if tektonUrl}
											<Button
												variant="outline"
												size="sm"
												href={tektonUrl}
												class="h-6 gap-1 px-2 text-[0.7rem]"
												target="_blank"
												rel="noreferrer"
											>
												<Loader2 class="size-3 text-amber-500 motion-safe:animate-spin" />
												PipelineRun
												<ExternalLink class="size-3" />
											</Button>
										{/if}
										<Button
											variant="outline"
											size="sm"
											href={releasePinsUrl(row.service)}
											class="h-6 gap-1 px-2 text-[0.7rem]"
											target="_blank"
											rel="noreferrer"
										>
											Release pins
											<ExternalLink class="size-3" />
										</Button>
										<Button
											variant="ghost"
											size="sm"
											class="h-6 gap-1 px-2 text-[0.7rem]"
											onclick={() => onOpenDetail(row.service)}
										>
											<Maximize2 class="size-3" />
											Full detail
										</Button>
									</div>
								</div>
							</td>
						</tr>
					{/if}
				{/each}
			</tbody>
		</table>
	{/if}
</div>

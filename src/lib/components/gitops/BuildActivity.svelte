<script lang="ts">
	import { CheckCircle2, CircleAlert, ExternalLink, Hammer } from "lucide-svelte";

	import { Badge } from "$lib/components/ui/badge";
	import { ENVIRONMENTS, type EnvCell, type ServiceRow } from "$lib/gitops/service-matrix";
	import {
		formatDurationMs,
		relativeTime,
		statusVariant,
	} from "$lib/utils/gitops-display";

	type BuildRow = {
		service: string;
		env: string;
		pipelineRun: string;
		status: string | null;
		reason: string | null;
		startedAt: string | null;
		finishedAt: string | null;
		durationMs: number | null;
	};

	type Props = {
		rows: ServiceRow[];
		tektonBase: string | null;
	};

	let { rows, tektonBase }: Props = $props();

	const builds = $derived.by(() => {
		const result: BuildRow[] = [];
		for (const row of rows) {
			for (const env of ENVIRONMENTS) {
				const cell: EnvCell | null = row.envs[env];
				if (!cell || !cell.buildPipelineRun) continue;
				const started = cell.buildStartedAt
					? new Date(cell.buildStartedAt).getTime()
					: null;
				const finished = cell.buildFinishedAt
					? new Date(cell.buildFinishedAt).getTime()
					: null;
				const durationMs =
					started != null && finished != null ? Math.max(0, finished - started) : null;
				result.push({
					service: row.service,
					env,
					pipelineRun: cell.buildPipelineRun,
					status: cell.buildStatus,
					reason: cell.buildReason,
					startedAt: cell.buildStartedAt,
					finishedAt: cell.buildFinishedAt,
					durationMs,
				});
			}
		}
		return result
			.sort((a, b) => {
				const ta = a.finishedAt ?? a.startedAt ?? "";
				const tb = b.finishedAt ?? b.startedAt ?? "";
				return tb.localeCompare(ta);
			})
			.slice(0, 12);
	});

	function tektonUrl(pipelineRun: string): string | null {
		if (!tektonBase) return null;
		const base = tektonBase.replace(/\/+$/, "");
		return `${base}/#/namespaces/tekton-pipelines/pipelineruns/${encodeURIComponent(pipelineRun)}`;
	}
</script>

<section class="space-y-3">
	<div class="flex items-baseline gap-2">
		<Hammer class="size-4 text-muted-foreground" />
		<h2 class="text-base font-semibold">Build activity</h2>
		<span class="text-[0.68rem] text-muted-foreground">
			{builds.length > 0 ? `${builds.length} recent PipelineRuns` : "nothing reported"}
		</span>
	</div>

	{#if builds.length === 0}
		<div class="rounded-lg border border-dashed bg-muted/10 p-4 text-sm text-muted-foreground">
			The hub inventory has not surfaced any PipelineRun metadata for these services. Builds
			may still be running, or the inventory controller may not be indexing outer-loop runs
			for this environment yet.
		</div>
	{:else}
		<ul class="divide-y rounded-lg border">
			{#each builds as build (`${build.service}:${build.env}:${build.pipelineRun}`)}
				{@const url = tektonUrl(build.pipelineRun)}
				{@const isSuccess = build.status === "True" || build.reason === "Succeeded"}
				{@const isFailed =
					build.status === "False" ||
					build.reason === "Failed" ||
					build.reason === "Failure"}
				<li class="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
					<div class="flex min-w-[9rem] items-center gap-2">
						{#if isSuccess}
							<CheckCircle2 class="size-3.5 text-emerald-500" />
						{:else if isFailed}
							<CircleAlert class="size-3.5 text-destructive" />
						{:else}
							<Hammer class="size-3.5 text-amber-500" />
						{/if}
						<span class="font-medium">{build.service}</span>
					</div>
					<Badge variant="outline" class="text-[0.65rem]">{build.env}</Badge>
					<Badge variant={statusVariant(build.status ?? build.reason)} class="text-[0.65rem]">
						{build.reason ?? build.status ?? "Unknown"}
					</Badge>
					<div class="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={build.pipelineRun}>
						{#if url}
							<a class="text-primary hover:underline" href={url} target="_blank" rel="noreferrer">
								{build.pipelineRun}
								<ExternalLink class="ml-1 inline size-3" />
							</a>
						{:else}
							{build.pipelineRun}
						{/if}
					</div>
					<div class="text-xs text-muted-foreground" title={build.startedAt ?? ""}>
						{relativeTime(build.finishedAt ?? build.startedAt)}
						{#if build.durationMs != null}
							· {formatDurationMs(build.durationMs)}
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

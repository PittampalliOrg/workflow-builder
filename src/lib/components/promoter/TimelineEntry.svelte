<script lang="ts">
	import { ExternalLink, GitPullRequest } from "@lucide/svelte";

	import StatusIcon from "$lib/components/promoter/StatusIcon.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import { githubCommitUrl, repoBrowseUrl } from "$lib/promoter/links";
	import type { TimelineEntry } from "$lib/promoter/timeline-view";
	import { relativeTime } from "$lib/utils/gitops-display";

	type Props = {
		entry: TimelineEntry;
	};

	let { entry }: Props = $props();

	const repoBrowse = $derived(repoBrowseUrl(entry.dryRepoUrl));
	const commitHref = $derived(githubCommitUrl(repoBrowse, entry.dryShaFull));

	const phaseTone = $derived.by(() => {
		switch (entry.finalPhase) {
			case "success":
				return "border-emerald-300/40 bg-emerald-50/40 dark:border-emerald-500/30 dark:bg-emerald-950/20";
			case "failure":
				return "border-destructive/40 bg-destructive/5";
			case "pending":
				return "border-amber-300/40 bg-amber-50/40 dark:border-amber-500/30 dark:bg-amber-950/20";
			default:
				return "border-border/60 bg-card/40";
		}
	});
</script>

<article
	data-sha={entry.dryShaFull ?? ""}
	data-id={entry.id}
	class="flex flex-col gap-1.5 rounded-lg border p-2.5 text-xs shadow-sm {phaseTone}"
>
	<header class="flex items-center justify-between gap-2">
		<div class="flex items-center gap-1.5">
			<StatusIcon phase={entry.finalPhase} size="xs" />
			{#if commitHref}
				<a
					href={commitHref}
					target="_blank"
					rel="noreferrer"
					class="font-mono text-[0.7rem] text-primary hover:underline"
					title={entry.dryShaFull ?? ""}
				>
					{entry.dryShaShort ?? "—"}
				</a>
			{:else}
				<span class="font-mono text-[0.7rem]" title={entry.dryShaFull ?? ""}>
					{entry.dryShaShort ?? "—"}
				</span>
			{/if}
		</div>
		<span class="text-[0.6rem] text-muted-foreground">
			{entry.endedAt ? relativeTime(entry.endedAt) : "—"}
		</span>
	</header>

	{#if entry.subject}
		<div class="line-clamp-2 text-[0.7rem]" title={entry.subject}>{entry.subject}</div>
	{/if}

	<footer class="flex items-center justify-between gap-2 text-[0.6rem] text-muted-foreground">
		{#if entry.author}<span>{entry.author}</span>{/if}
		{#if entry.pullRequest?.url || entry.pullRequest?.number != null}
			<a
				href={entry.pullRequest.url ?? "#"}
				target="_blank"
				rel="noreferrer"
				class="inline-flex items-center gap-0.5 text-primary hover:underline"
				title="Open pull request"
			>
				<GitPullRequest class="size-2.5" />
				PR #{entry.pullRequest.number ?? "—"}
				<ExternalLink class="size-2.5" />
			</a>
		{/if}
	</footer>

	{#if entry.commitStatuses.length > 0}
		<div class="flex flex-wrap items-center gap-1 text-[0.6rem]">
			{#each entry.commitStatuses as check (check.key)}
				<Badge
					variant={check.phase === "success"
						? "secondary"
						: check.phase === "failure"
							? "destructive"
							: "outline"}
					class="h-4 gap-0.5 px-1 font-normal"
					title={check.description ?? check.key}
				>
					<StatusIcon phase={check.phase} size="xs" />
					{check.key}
				</Badge>
			{/each}
		</div>
	{/if}
</article>

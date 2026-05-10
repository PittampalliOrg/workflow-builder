<script lang="ts">
	import { ExternalLink, GitBranch } from "@lucide/svelte";

	import StatusIcon from "$lib/components/promoter/StatusIcon.svelte";
	import StuckOnCell from "$lib/components/promoter/StuckOnCell.svelte";
	import { Badge } from "$lib/components/ui/badge";
	import type { InboxRow } from "$lib/promoter/inbox-view";
	import { argoCdAppUrl, githubCommitUrl, repoBrowseUrl } from "$lib/promoter/links";
	import { relativeTime } from "$lib/utils/gitops-display";

	type Props = {
		row: InboxRow;
		argoCdBase: string;
		stacksRepo: string;
		onOpenStrategy: (name: string) => void;
	};

	let { row, argoCdBase, stacksRepo, onOpenStrategy }: Props = $props();

	const repoUrl = $derived(repoBrowseUrl(stacksRepo));
	const commitUrl = $derived(githubCommitUrl(repoUrl, row.latestDryFullSha));
	const argoUrl = $derived(
		argoCdAppUrl({ argoCdBase }, { name: row.name, namespace: row.namespace }),
	);

	const phaseBadge = $derived.by(() => {
		switch (row.phase) {
			case "failure":
				return { variant: "destructive" as const, text: "Failed" };
			case "pending":
				return { variant: "outline" as const, text: "Pending" };
			case "healthy":
				return { variant: "secondary" as const, text: "Healthy" };
			default:
				return { variant: "outline" as const, text: "Unknown" };
		}
	});

	const phaseIcon = $derived(
		row.phase === "healthy"
			? "success"
			: row.phase === "failure"
				? "failure"
				: row.phase === "pending"
					? "pending"
					: "unknown",
	);
</script>

<tr
	class="cursor-pointer border-b text-sm transition-colors hover:bg-muted/40"
	onclick={() => onOpenStrategy(row.name)}
>
	<td class="px-3 py-2">
		<div class="flex flex-col">
			<span class="font-medium">{row.name}</span>
			<span class="text-[0.65rem] text-muted-foreground">{row.namespace}</span>
		</div>
	</td>
	<td class="px-3 py-2">
		<Badge variant={phaseBadge.variant} class="h-5 gap-1 px-1.5 text-[0.65rem]">
			<StatusIcon phase={phaseIcon} size="xs" />
			{phaseBadge.text}
		</Badge>
	</td>
	<td class="px-3 py-2">
		{#if row.latestDryShaShort}
			{#if commitUrl}
				<a
					href={commitUrl}
					target="_blank"
					rel="noreferrer"
					onclick={(e) => e.stopPropagation()}
					class="font-mono text-[0.7rem] text-primary hover:underline"
					title={row.latestDryFullSha ?? row.latestDryShaShort}
				>
					{row.latestDryShaShort}
				</a>
			{:else}
				<span class="font-mono text-[0.7rem]" title={row.latestDryFullSha}>
					{row.latestDryShaShort}
				</span>
			{/if}
			{#if row.latestDrySubject}
				<span class="ml-2 line-clamp-1 text-[0.7rem] text-muted-foreground" title={row.latestDrySubject}>
					{row.latestDrySubject}
				</span>
			{/if}
		{:else}
			<span class="text-xs text-muted-foreground">—</span>
		{/if}
	</td>
	<td class="px-3 py-2">
		<span class="text-[0.7rem] text-muted-foreground">
			{row.latestActivity ? relativeTime(row.latestActivity) : "—"}
		</span>
	</td>
	<td class="px-3 py-2">
		<StuckOnCell stuckOn={row.stuckOn} />
	</td>
	<td class="px-3 py-2">
		<div class="flex items-center justify-end gap-2 text-[0.65rem]">
			{#if row.gitRepositoryName}
				<Badge variant="outline" class="h-4 px-1 text-[0.6rem]">
					<GitBranch class="size-2.5" />
					{row.gitRepositoryName}
				</Badge>
			{/if}
			{#if argoUrl}
				<a
					href={argoUrl}
					target="_blank"
					rel="noreferrer"
					onclick={(e) => e.stopPropagation()}
					class="inline-flex items-center gap-0.5 text-primary hover:underline"
					title="Open ArgoCD"
				>
					Argo
					<ExternalLink class="size-2.5" />
				</a>
			{/if}
		</div>
	</td>
</tr>

<script lang="ts">
	import { ExternalLink } from "@lucide/svelte";

	import CopyButton from "$lib/components/gitops/CopyButton.svelte";
	import { githubCommitUrl, repoBrowseUrl } from "$lib/promoter/links";
	import type { Commit } from "$lib/server/promoter/types";
	import { relativeTime } from "$lib/utils/gitops-display";

	type Props = {
		commit: Commit | null | undefined;
		label: "dry" | "hyd";
	};

	let { commit, label }: Props = $props();

	const browseUrl = $derived(repoBrowseUrl(commit?.repoURL));
	const commitUrl = $derived(githubCommitUrl(browseUrl, commit?.sha));
	const shortSha = $derived(commit?.sha ? commit.sha.slice(0, 8) : null);
</script>

{#if commit && shortSha}
	<div class="flex flex-col gap-0.5">
		<div class="flex items-center gap-1">
			<span class="text-[0.6rem] uppercase tracking-wider text-muted-foreground">{label}</span>
			{#if commitUrl}
				<a
					href={commitUrl}
					target="_blank"
					rel="noreferrer"
					class="inline-flex items-center gap-0.5 font-mono text-[0.75rem] text-primary hover:underline"
					title={commit.sha}
				>
					{shortSha}
					<ExternalLink class="size-2.5" />
				</a>
			{:else}
				<span class="font-mono text-[0.75rem]" title={commit.sha}>{shortSha}</span>
			{/if}
			<CopyButton value={commit.sha} />
		</div>
		{#if label === "dry" && commit.subject}
			<div class="line-clamp-2 text-[0.7rem]" title={commit.body || commit.subject}>
				{commit.subject}
			</div>
		{/if}
		{#if label === "dry" && (commit.author || commit.commitTime)}
			<div class="flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
				{#if commit.author}<span>{commit.author}</span>{/if}
				{#if commit.commitTime}<span>· {relativeTime(commit.commitTime)}</span>{/if}
			</div>
		{/if}
	</div>
{:else}
	<div class="flex items-center gap-1 text-[0.7rem] text-muted-foreground">
		<span class="text-[0.6rem] uppercase tracking-wider">{label}</span>
		<span>—</span>
	</div>
{/if}

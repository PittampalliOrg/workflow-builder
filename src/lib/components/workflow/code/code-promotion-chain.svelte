<!--
	The promote chain for a code version: version → PR → preview state → verify
	verdict. One presentational component rendered in BOTH promote surfaces (the
	dev code-versions panel and the run-cockpit Code tab) so they stay identical.

	Reads the preview state through the resume-safe `getPrPreviewStatus` remote
	(prPreviews.peek — a browser poll never kicks a pipeline). Degrades
	gracefully: with PR previews off (or no record yet) only the version + PR
	link render; the preview / verify segments appear as their state arrives.
-->
<script lang="ts">
	import StatusPill from '$lib/components/shared/status-pill.svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { ChevronRight, ExternalLink, GitPullRequest } from '@lucide/svelte';
	import { getPrPreviewStatus } from '../../../../routes/workspaces/[slug]/workflows/pr-preview-status.remote';

	interface Props {
		/** Explicit PR number, else parsed from `prUrl`. */
		prNumber?: number | null;
		prUrl?: string | null;
		/** Short code-version label for the leading segment (tier / iteration). */
		version?: string | null;
		class?: string;
	}

	let { prNumber = null, prUrl = null, version = null, class: className = '' }: Props = $props();

	function parsePrNumber(url: string | null): number | null {
		if (!url) return null;
		const m = url.match(/\/pull\/(\d+)/);
		return m ? Number(m[1]) : null;
	}

	const resolvedPr = $derived(prNumber ?? parsePrNumber(prUrl));
	const statusQuery = $derived(
		resolvedPr != null ? getPrPreviewStatus(resolvedPr) : undefined
	);
	// null = flag off / not loaded yet; the preview + verify segments stay hidden.
	const view = $derived(statusQuery?.current ?? null);
	const preview = $derived(view?.status ?? null);
	const href = $derived(prUrl ?? view?.prUrl ?? null);
</script>

{#if resolvedPr != null}
	<div class="flex items-center gap-1.5 flex-wrap text-[11px] {className}">
		{#if version}
			<Badge variant="outline" class="font-mono text-[10px]">{version}</Badge>
			<ChevronRight class="size-3 text-muted-foreground shrink-0" />
		{/if}

		{#if href}
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				class="inline-flex items-center gap-1 text-primary hover:underline"
			>
				<GitPullRequest class="size-3" /> PR #{resolvedPr}
			</a>
		{:else}
			<span class="inline-flex items-center gap-1 text-muted-foreground">
				<GitPullRequest class="size-3" /> PR #{resolvedPr}
			</span>
		{/if}

		{#if preview && preview.state !== 'absent'}
			<ChevronRight class="size-3 text-muted-foreground shrink-0" />
			<StatusPill status={preview.state} />
			{#if preview.state === 'ready' && preview.url}
				<a
					href={preview.url}
					target="_blank"
					rel="noopener noreferrer"
					class="inline-flex items-center gap-1 text-primary hover:underline"
				>
					Preview <ExternalLink class="size-3" />
				</a>
			{/if}

			{#if preview.verify}
				<ChevronRight class="size-3 text-muted-foreground shrink-0" />
				<span title={preview.verify.reason ?? preview.verify.verdict ?? ''}>
					<StatusPill status={preview.verify.state} label={`Verify: ${preview.verify.state}`} />
				</span>
			{/if}
		{/if}
	</div>
{/if}

<!--
	Dedupe indicator for a promotion-receipt link on an environment card: when
	the receipt's PR is ALSO in the PR-preview lane (same PR number) or a PR
	preview exists for the same head SHA, flags that a preview already exists
	for this code so nobody labels up a duplicate. Renders nothing when there is
	no match — safe to drop next to any receipt link.
-->
<script lang="ts">
	import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '$lib/components/ui/tooltip';
	import { ExternalLink, Layers } from '@lucide/svelte';
	import { findPrPreviewForReceipt } from '$lib/components/dev/preview-dedupe';
	import type { PreviewPromotionReceiptSummary, PrPreviewListItem } from '$lib/types/dev-previews';

	let {
		receipt,
		prPreviews = []
	}: {
		receipt: PreviewPromotionReceiptSummary;
		/** The PR-preview lane snapshot (getPrPreviews items). */
		prPreviews?: PrPreviewListItem[];
	} = $props();

	const match = $derived(findPrPreviewForReceipt(receipt, prPreviews));
	const href = $derived(match ? (match.item.url ?? match.item.prUrl) : null);
	const detail = $derived(
		match
			? match.matchedBy === 'pr-number'
				? `PR preview #${match.item.prNumber} runs the code this receipt promoted (same pull request).`
				: `PR preview #${match.item.prNumber} runs the code this receipt promoted (same head commit).`
			: null
	);
</script>

{#if match}
	<TooltipProvider>
		<Tooltip>
			<TooltipTrigger>
				{#if href}
					<a
						href={href}
						target="_blank"
						rel="noopener noreferrer"
						class="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
					>
						<Layers class="size-3" aria-hidden="true" /> preview exists for this code
						<ExternalLink class="size-2.5" aria-hidden="true" />
					</a>
				{:else}
					<span
						class="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
					>
						<Layers class="size-3" aria-hidden="true" /> preview exists for this code
					</span>
				{/if}
			</TooltipTrigger>
			<TooltipContent>
				<p class="max-w-[280px] text-xs">{detail}</p>
			</TooltipContent>
		</Tooltip>
	</TooltipProvider>
{/if}

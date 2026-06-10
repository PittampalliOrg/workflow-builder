<script lang="ts">
	import { Badge } from '$lib/components/ui/badge';
	import {
		Tooltip,
		TooltipContent,
		TooltipProvider,
		TooltipTrigger
	} from '$lib/components/ui/tooltip';
	import { AlertTriangle, Layers } from '@lucide/svelte';
	import {
		estimateToolTokens,
		TOOL_SURFACE_WARN_COUNT,
		TOOL_SURFACE_WARN_TOKENS
	} from '$lib/connections/agent-mcp';

	interface Props {
		/** Σ effective tool count over servers with KNOWN tool lists. */
		toolCount: number;
		/** Total attached/included servers contributing to the surface. */
		serverCount: number;
		/** Servers whose tool count is unknown (custom/hosted/preset). */
		unknownServerCount?: number;
	}

	let { toolCount, serverCount, unknownServerCount = 0 }: Props = $props();

	const estTokens = $derived(estimateToolTokens(toolCount));
	const isLarge = $derived(
		toolCount > TOOL_SURFACE_WARN_COUNT || estTokens > TOOL_SURFACE_WARN_TOKENS
	);

	function formatTokens(n: number): string {
		if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
		return String(n);
	}
</script>

<div
	class="flex items-center justify-between gap-3 flex-wrap rounded-md border bg-muted/30 px-3 py-2"
>
	<div class="flex items-center gap-2 text-sm min-w-0">
		<Layers class="size-4 text-muted-foreground shrink-0" />
		<span class="text-muted-foreground">Effective tool surface:</span>
		<span class="font-medium">
			{toolCount}{unknownServerCount > 0 ? '+?' : ''} tools
		</span>
		<span class="text-muted-foreground">across</span>
		<span class="font-medium">{serverCount} {serverCount === 1 ? 'server' : 'servers'}</span>
		<span class="text-muted-foreground">·</span>
		{#if unknownServerCount > 0}
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger class="text-muted-foreground underline decoration-dotted">
						~{formatTokens(estTokens)} tok/turn
					</TooltipTrigger>
					<TooltipContent>
						<p class="max-w-[220px] text-xs">
							{unknownServerCount} server{unknownServerCount === 1 ? '' : 's'}
							(custom URL / hosted / browser preset) expose an unknown tool count, so the
							estimate covers only servers with a known tool list.
						</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		{:else}
			<span class="text-muted-foreground">~{formatTokens(estTokens)} tok/turn</span>
		{/if}
	</div>
	{#if isLarge}
		<Badge
			variant="outline"
			class="gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300 text-[11px]"
		>
			<AlertTriangle class="size-3" />
			Large tool surface may dilute selection &amp; inflate cost — consider narrowing
		</Badge>
	{/if}
</div>

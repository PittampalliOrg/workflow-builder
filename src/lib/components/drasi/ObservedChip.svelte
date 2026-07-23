<script lang="ts">
	import { Badge } from "$lib/components/ui/badge";
	import type { DrasiObservedStatus } from "$lib/types/drasi";

	let { status, class: className = "" }: { status: DrasiObservedStatus; class?: string } =
		$props();

	const STYLES: Record<DrasiObservedStatus, { label: string; cls: string; dot: string }> = {
		observed: {
			label: "Observed",
			cls: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-200",
			dot: "bg-emerald-500",
		},
		stale: {
			label: "Stale",
			cls: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-950/30 dark:text-amber-200",
			dot: "bg-amber-500",
		},
		unavailable: {
			label: "Unavailable",
			cls: "text-muted-foreground",
			dot: "bg-muted-foreground/60",
		},
	};

	let style = $derived(STYLES[status]);
</script>

<Badge
	variant="outline"
	class="h-5 gap-1.5 px-1.5 text-[0.65rem] font-medium {style.cls} {className}"
>
	<span class="size-1.5 rounded-full {style.dot}" aria-hidden="true"></span>
	{style.label}
</Badge>

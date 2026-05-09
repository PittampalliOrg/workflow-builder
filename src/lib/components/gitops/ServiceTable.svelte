<script lang="ts">
	import { AlertTriangle, CheckCircle2, Circle, CircleSlash } from "@lucide/svelte";

	import { summarizeRow, type ServiceRow } from "$lib/gitops/service-matrix";
	import { relativeTime } from "$lib/utils/gitops-display";

	type Props = {
		rows: ServiceRow[];
		selectedService: string | null;
		onSelect: (service: string) => void;
		now?: number;
	};

	let { rows, selectedService, onSelect, now }: Props = $props();

	let listEl = $state<HTMLDivElement | null>(null);

	function handleKey(event: KeyboardEvent) {
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
		const idx = rows.findIndex((row) => row.service === selectedService);
		if (event.key === "ArrowDown" && idx < rows.length - 1) {
			event.preventDefault();
			onSelect(rows[idx + 1].service);
		} else if (event.key === "ArrowUp" && idx > 0) {
			event.preventDefault();
			onSelect(rows[idx - 1].service);
		}
	}

	function iconFor(overall: ReturnType<typeof summarizeRow>["overall"]) {
		if (overall === "healthy") return CheckCircle2;
		if (overall === "drift") return AlertTriangle;
		if (overall === "degraded") return AlertTriangle;
		if (overall === "empty") return CircleSlash;
		return Circle;
	}

	function colorFor(overall: ReturnType<typeof summarizeRow>["overall"]) {
		if (overall === "healthy") return "text-emerald-500";
		if (overall === "drift") return "text-amber-500";
		if (overall === "degraded") return "text-destructive";
		if (overall === "empty") return "text-muted-foreground/40";
		return "text-muted-foreground";
	}
</script>

<div
	bind:this={listEl}
	role="listbox"
	aria-label="Services"
	tabindex="0"
	class="flex h-full flex-col overflow-y-auto focus:outline-none"
	onkeydown={handleKey}
>
	{#if rows.length === 0}
		<div class="p-6 text-center text-sm text-muted-foreground">
			No services match the current filter.
		</div>
	{:else}
		<ul class="divide-y">
			{#each rows as row (row.service)}
				{@const summary = summarizeRow(row)}
				{@const Icon = iconFor(summary.overall)}
				{@const selected = row.service === selectedService}
				<li>
					<button
						type="button"
						class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/60
							{selected ? 'bg-muted' : ''}"
						role="option"
						aria-selected={selected}
						onclick={() => onSelect(row.service)}
					>
						<Icon class={`size-3.5 shrink-0 ${colorFor(summary.overall)}`} />
						<div class="min-w-0 flex-1">
							<div class="truncate text-sm font-medium">{row.service}</div>
							{#if row.specialCase}
								<div class="truncate text-[0.65rem] text-muted-foreground">
									{row.specialCase === "sandbox-only"
											? "sandbox"
											: row.specialCase === "ryzen-missing-pin"
												? "no ryzen pin"
												: "ryzen-only"}
								</div>
							{/if}
						</div>
						<div class="shrink-0 whitespace-nowrap text-[0.68rem] text-muted-foreground">
							{relativeTime(summary.updatedAt, now)}
						</div>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</div>

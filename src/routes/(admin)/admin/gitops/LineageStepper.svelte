<script lang="ts">
	import { CheckCircle2, CircleDashed, Clock3, Loader2 } from "@lucide/svelte";

	import type { LineageStep } from "$lib/gitops/fleet-drift-view";
	import { relativeTime, shortTag } from "$lib/utils/gitops-display";

	type Props = {
		steps: LineageStep[];
		now?: number;
	};

	let { steps, now }: Props = $props();

	function stepIcon(state: LineageStep["state"]) {
		if (state === "done") return CheckCircle2;
		if (state === "active") return Loader2;
		if (state === "pending") return Clock3;
		return CircleDashed;
	}

	function stepColor(state: LineageStep["state"]): string {
		if (state === "done") return "text-emerald-500";
		if (state === "active" || state === "pending") return "text-amber-500";
		return "text-muted-foreground/50";
	}

	function connectorColor(state: LineageStep["state"]): string {
		if (state === "done") return "bg-emerald-500/40";
		if (state === "active" || state === "pending") return "bg-amber-500/40";
		return "bg-border";
	}
</script>

<!-- Built → Pinned → Deployed image lineage as a small horizontal stepper. -->
<ol class="flex min-w-max items-stretch gap-0" aria-label="Image lineage">
	{#each steps as step, index (step.id)}
		{@const Icon = stepIcon(step.state)}
		<li class="flex items-stretch">
			{#if index > 0}
				<span
					class="mt-[0.8rem] h-px w-6 shrink-0 self-start sm:w-9 {connectorColor(step.state)}"
					aria-hidden="true"
				></span>
			{/if}
			<div class="flex min-w-[7.5rem] flex-col gap-0.5 px-1">
				<div class="flex items-center gap-1.5">
					<Icon
						class="size-3.5 shrink-0 {stepColor(step.state)} {step.state === 'active'
							? 'motion-safe:animate-spin'
							: ''}"
					/>
					<span class="text-[0.65rem] font-semibold uppercase tracking-wide text-muted-foreground">
						{step.label}
					</span>
				</div>
				<span class="truncate font-mono text-xs" title={step.tag ?? undefined}>
					{shortTag(step.tag)}
				</span>
				<span class="truncate text-[0.65rem] text-muted-foreground">
					{#if step.detail}
						{step.detail}{step.at ? ` · ${relativeTime(step.at, now)}` : ""}
					{:else if step.at}
						{relativeTime(step.at, now)}
					{:else}
						—
					{/if}
				</span>
			</div>
		</li>
	{/each}
</ol>

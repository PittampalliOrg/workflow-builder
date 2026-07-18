<script lang="ts">
	import {
		Bot,
		CircleCheck,
		GitPullRequest,
		Moon,
		ShieldCheck,
		TimerReset,
		TriangleAlert
	} from '@lucide/svelte';
	import {
		Tooltip,
		TooltipContent,
		TooltipProvider,
		TooltipTrigger
	} from '$lib/components/ui/tooltip';
	import { STAGE_META, STAGE_STEP_TOTAL } from '$lib/components/dev/preview-drift-view';
	import type { PreviewStage } from '$lib/types/dev-previews';

	let {
		stage,
		class: className = ''
	}: {
		stage: PreviewStage;
		class?: string;
	} = $props();

	const STAGE_ICONS = {
		provisioning: TimerReset,
		ready: CircleCheck,
		retained: ShieldCheck,
		'agent-editing': Bot,
		promoted: GitPullRequest,
		sleeping: Moon,
		failed: TriangleAlert
	} as const;

	const meta = $derived(STAGE_META[stage]);
	const StageIcon = $derived(STAGE_ICONS[stage]);
</script>

<TooltipProvider>
	<Tooltip>
		<TooltipTrigger
			class="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-medium {meta.badgeClass} {className}"
			aria-label={`Dev-cycle stage: ${meta.label}`}
		>
			<StageIcon class="size-3" aria-hidden="true" />
			{meta.label}
			{#if meta.step !== null}
				<span class="ml-0.5 inline-flex items-center gap-0.5" aria-hidden="true">
					{#each Array(STAGE_STEP_TOTAL) as _, index (index)}
						<span
							class="size-1 rounded-full {index < meta.step
								? 'bg-current'
								: 'bg-current opacity-25'}"
						></span>
					{/each}
				</span>
			{/if}
		</TooltipTrigger>
		<TooltipContent>
			<p class="max-w-[240px] text-xs">
				<span class="font-medium">{meta.label}</span>
				{#if meta.step !== null}
					<span class="text-muted-foreground"> · step {meta.step}/{STAGE_STEP_TOTAL}</span>
				{/if}
			</p>
			<p class="max-w-[240px] text-xs text-muted-foreground">{meta.description}</p>
		</TooltipContent>
	</Tooltip>
</TooltipProvider>

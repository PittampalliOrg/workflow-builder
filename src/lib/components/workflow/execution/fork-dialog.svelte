<script lang="ts">
	/**
	 * Fork/resume confirmation dialog — used by the run-detail header, the canvas
	 * "Fork from here" action, and the Code-tab "Fork from this checkpoint" action.
	 *
	 * The dialog owns the fork point: it lists the run's completed top-level steps
	 * and lets the user pick where replay begins (defaulting to the step the caller
	 * invoked from). Two explicit modes share one resume endpoint — "Reproduce"
	 * re-runs the selected suffix unchanged (a deterministic baseline) and "Fork"
	 * iterates on the current, possibly edited, spec. It previews which steps are
	 * SKIPPED (reused) vs RE-RUN and, when per-step usage is known, how much prior
	 * work the skipped prefix reuses. The caller owns the fetch (`forkRun`) +
	 * navigation via `onConfirm`.
	 */
	import { GitFork, RefreshCw, Check } from '@lucide/svelte';
	import {
		AlertDialog,
		AlertDialogAction,
		AlertDialogCancel,
		AlertDialogContent,
		AlertDialogDescription,
		AlertDialogFooter,
		AlertDialogHeader,
		AlertDialogTitle
	} from '$lib/components/ui/alert-dialog';
	import { fmtTokens } from '$lib/utils/format-tokens';
	import { splitAtFork, summarizeReuse, type ForkStep } from '$lib/utils/fork-steps';
	import type { ForkMode } from '$lib/workflows/fork';

	interface Props {
		open: boolean;
		/** Terminal framing: "Resume" (failed run) vs "Fork" (successful run). */
		verb?: string;
		/** Completed top-level steps in execution order (fork points). */
		steps: ForkStep[];
		/** The chosen fork point — bindable so the picker drives replay. */
		selectedStepId?: string | null;
		/** Replay mode — bindable. */
		mode?: ForkMode;
		busy?: boolean;
		error?: string | null;
		onConfirm: () => void;
	}

	let {
		open = $bindable(),
		verb = 'Fork',
		steps,
		selectedStepId = $bindable<string | null>(null),
		mode = $bindable<ForkMode>('fork'),
		busy = false,
		error = null,
		onConfirm
	}: Props = $props();

	const split = $derived(splitAtFork(steps, selectedStepId));
	const reuse = $derived(summarizeReuse(steps, split.selectedIndex < 0 ? 0 : split.selectedIndex));
	const selectedStep = $derived(steps.find((s) => s.id === selectedStepId) ?? null);
	const effectiveLabel = $derived(selectedStep?.label ?? null);
	// Reproduce is only meaningful when the fork re-runs from an actual step.
	const actionVerb = $derived(mode === 'reproduce' ? 'Reproduce' : verb);
</script>

<AlertDialog {open} onOpenChange={(o) => (open = o)}>
	<AlertDialogContent class="max-w-lg">
		<AlertDialogHeader>
			<AlertDialogTitle class="flex items-center gap-2">
				<GitFork class="size-4 text-primary" />
				{actionVerb} from {effectiveLabel ? `“${effectiveLabel}”` : 'the failed step'}
			</AlertDialogTitle>
			<AlertDialogDescription>
				Starts a new run on an <span class="font-medium">isolated copy</span> of this run's
				workspace. Earlier steps are skipped; only the selected step onward re-runs — so parallel
				forks never interfere.
			</AlertDialogDescription>
		</AlertDialogHeader>

		<!-- Mode: Reproduce (deterministic replay) vs Fork (iterate on edits). -->
		<div class="grid grid-cols-2 gap-2">
			<button
				type="button"
				onclick={() => (mode = 'reproduce')}
				class="flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left transition-colors {mode === 'reproduce' ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:bg-muted/50'}"
			>
				<span class="flex items-center gap-1.5 text-sm font-medium">
					<RefreshCw class="size-3.5" /> Reproduce
				</span>
				<span class="text-[11px] leading-snug text-muted-foreground">
					Re-run the selected steps unchanged — a deterministic baseline.
				</span>
			</button>
			<button
				type="button"
				onclick={() => (mode = 'fork')}
				class="flex flex-col items-start gap-0.5 rounded-md border p-2.5 text-left transition-colors {mode === 'fork' ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:bg-muted/50'}"
			>
				<span class="flex items-center gap-1.5 text-sm font-medium">
					<GitFork class="size-3.5" /> Fork
				</span>
				<span class="text-[11px] leading-snug text-muted-foreground">
					Iterate — re-run with your current workflow edits.
				</span>
			</button>
		</div>

		<!-- Fork point picker: choose where replay begins. -->
		{#if steps.length > 0}
			<div>
				<div class="mb-1 text-xs font-medium text-muted-foreground">Fork from step</div>
				<div class="max-h-44 overflow-y-auto rounded-md border border-border">
					{#each steps as step (step.id)}
						<button
							type="button"
							onclick={() => (selectedStepId = step.id)}
							class="flex w-full items-center gap-2 border-b border-border px-2.5 py-1.5 text-left text-xs last:border-b-0 hover:bg-muted/60 {step.id === selectedStepId ? 'bg-muted' : ''}"
						>
							<span class="w-4 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">{step.index + 1}</span>
							<code class="min-w-0 flex-1 truncate">{step.label}</code>
							{#if step.tokens !== null}
								<span class="shrink-0 text-[10px] tabular-nums text-muted-foreground">{fmtTokens(step.tokens)} tok</span>
							{/if}
							{#if step.isFailed}
								<span class="shrink-0 text-[9px] font-medium text-red-500">failed here</span>
							{/if}
							{#if step.id === selectedStepId}
								<Check class="size-3 shrink-0 text-primary" />
							{/if}
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Reuse summary: how much prior work the skipped prefix reuses. -->
		{#if reuse.stepCount > 0}
			<div class="rounded-md bg-muted/50 px-2.5 py-1.5 text-[11px] text-muted-foreground">
				Reuses <span class="font-medium text-foreground">{reuse.stepCount}</span>
				step{reuse.stepCount === 1 ? '' : 's'}
				{#if reuse.tokens !== null}
					· <span class="font-medium text-foreground">{fmtTokens(reuse.tokens)}</span> tokens of prior work
				{/if}
			</div>
		{/if}

		<div class="space-y-3 py-1 text-xs">
			<div>
				<div class="mb-1 font-medium text-muted-foreground">
					Skipped — reused from this run ({split.skipped.length})
				</div>
				<div class="flex flex-wrap gap-1">
					{#each split.skipped as step (step.id)}
						<span class="rounded bg-muted px-1.5 py-0.5 text-muted-foreground line-through">{step.label}</span>
					{/each}
					{#if split.skipped.length === 0}
						<span class="text-muted-foreground italic">none — runs from the start</span>
					{/if}
				</div>
			</div>
			<div>
				<div class="mb-1 font-medium text-primary">
					{mode === 'reproduce' ? 'Re-runs unchanged' : 'Re-runs with current workflow'} ({split.rerun.length})
				</div>
				<div class="flex flex-wrap gap-1">
					{#each split.rerun as step (step.id)}
						<span class="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">{step.label}</span>
					{/each}
				</div>
			</div>
			{#if error}
				<div class="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-red-600 dark:text-red-400">
					{error}
				</div>
			{/if}
		</div>

		<AlertDialogFooter>
			<AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={onConfirm} disabled={busy}>
				{busy ? `${actionVerb}ing…` : `${actionVerb} from here`}
			</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

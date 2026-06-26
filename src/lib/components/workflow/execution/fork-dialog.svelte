<script lang="ts">
	/**
	 * Shared fork/resume confirmation dialog — used by the run-detail header AND the
	 * canvas "Fork from here" action. Pure presentation: it previews which steps are
	 * SKIPPED (reused from the source run's workspace) vs RE-RUN (with the current,
	 * possibly edited spec), and calls `onConfirm`. The caller owns the fetch
	 * (`forkRun` in $lib/workflows/fork) + navigation/overlay.
	 */
	import { GitFork } from '@lucide/svelte';
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

	interface Props {
		open: boolean;
		/** "Resume" (recover a failed run) vs "Fork" (iterate on a successful one). */
		verb?: string;
		/** The node being forked from (null → the in-flight/failed step). */
		effectiveNode: string | null;
		/** Top-level node names skipped (reused) vs re-run, in order. */
		skipped: string[];
		rerun: string[];
		busy?: boolean;
		error?: string | null;
		onConfirm: () => void;
	}

	let {
		open = $bindable(),
		verb = 'Fork',
		effectiveNode,
		skipped,
		rerun,
		busy = false,
		error = null,
		onConfirm
	}: Props = $props();
</script>

<AlertDialog {open} onOpenChange={(o) => (open = o)}>
	<AlertDialogContent class="max-w-lg">
		<AlertDialogHeader>
			<AlertDialogTitle class="flex items-center gap-2">
				<GitFork class="size-4 text-primary" />
				{verb} from {effectiveNode ? `“${effectiveNode}”` : 'the failed step'}
			</AlertDialogTitle>
			<AlertDialogDescription>
				Starts a new run of the <span class="font-medium">current</span> workflow on an
				<span class="font-medium">isolated copy</span> of this run's workspace. Earlier steps are
				skipped; only the selected step onward re-runs — so your edits to that step (and later) take
				effect, and parallel forks never interfere.
			</AlertDialogDescription>
		</AlertDialogHeader>

		<div class="space-y-3 py-1 text-xs">
			<div>
				<div class="mb-1 font-medium text-muted-foreground">
					Skipped — reused from this run ({skipped.length})
				</div>
				<div class="flex flex-wrap gap-1">
					{#each skipped as n (n)}
						<span class="rounded bg-muted px-1.5 py-0.5 text-muted-foreground line-through">{n}</span>
					{/each}
					{#if skipped.length === 0}
						<span class="text-muted-foreground italic">none — runs from the start</span>
					{/if}
				</div>
			</div>
			<div>
				<div class="mb-1 font-medium text-primary">
					Re-runs with current workflow ({rerun.length})
				</div>
				<div class="flex flex-wrap gap-1">
					{#each rerun as n (n)}
						<span class="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">{n}</span>
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
				{busy ? `${verb}ing…` : `${verb} from here`}
			</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

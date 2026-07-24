<script lang="ts">
	/**
	 * Master-detail view of a run's git-backed workspace checkpoints — extracted
	 * from the run-detail Code tab so both the run page and the session-detail Code
	 * & Changes panel render checkpoints identically.
	 *
	 * The parent owns the `checkpoints` array (the run page already loads it for the
	 * timeline + tab gating; the session page loads a session-filtered copy). This
	 * component owns selection, on-demand diff loading, restore, copy-ref, and the
	 * optional "fork from this checkpoint" hand-off.
	 */
	import { RefreshCw, FileDiff, CircleAlert, Loader2, GitFork, Copy, Check, ExternalLink } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import RenderedPatch from '$lib/components/benchmarks/rendered-patch.svelte';
	import { stripDiffStatPreamble } from '$lib/utils/unified-diff';
	import {
		type CodeCheckpoint,
		type CodeCheckpointFile,
		checkpointFilePath,
		checkpointFileStatusLabel,
		checkpointFileSummary,
		checkpointGitChangeLabel,
		checkpointGitRemoteLabel,
		checkpointIsDurable,
		checkpointMatchesSession,
		checkpointRemoteLabel,
		checkpointShaRange,
		checkpointShouldShowRemoteError,
		fetchCheckpointDiff,
		restoreCheckpointToSandbox,
		shortSha
	} from '$lib/utils/code-checkpoints';

	interface Props {
		executionId: string;
		/** Owner-provided checkpoint list (already fetched). */
		checkpoints: CodeCheckpoint[];
		loading?: boolean;
		error?: string | null;
		onRefresh?: (() => void) | null;
		/** Bindable so parents (timeline markers, cross-links) can drive selection. */
		selectedCheckpointId?: string | null;
		/** Restore fallback when a checkpoint has no sandbox recorded. */
		activeSandboxName?: string | null;
		/** When set, renders "Fork from this checkpoint" and hands the checkpoint back. */
		onForkCheckpoint?: ((checkpoint: CodeCheckpoint) => void) | null;
		/** When set, filters checkpoints to a single session (session-detail panel). */
		sessionFilter?: string | null;
		/** When set, renders an "Open in run page → Code tab" cross-link. */
		runHref?: string | null;
		/** Compact chrome (drop the header row) for embedding in a session panel. */
		compact?: boolean;
	}

	let {
		executionId,
		checkpoints,
		loading = false,
		error = null,
		onRefresh = null,
		selectedCheckpointId = $bindable<string | null>(null),
		activeSandboxName = null,
		onForkCheckpoint = null,
		sessionFilter = null,
		runHref = null,
		compact = false
	}: Props = $props();

	const visibleCheckpoints = $derived(
		checkpoints.filter((checkpoint) => checkpointMatchesSession(checkpoint, sessionFilter))
	);
	const changeCount = $derived(
		visibleCheckpoints.filter((checkpoint) => checkpoint.status === 'created').length
	);
	const durableCount = $derived(visibleCheckpoints.filter(checkpointIsDurable).length);
	const selectedCheckpoint = $derived(
		visibleCheckpoints.find((checkpoint) => checkpoint.id === selectedCheckpointId) ?? null
	);

	let selectedPath = $state<string | null>(null);
	let codeDiff = $state('');
	const codeDiffPatch = $derived(stripDiffStatPreamble(codeDiff));
	let codeDiffLoading = $state(false);
	let codeDiffError = $state<string | null>(null);

	let restorePending = $state(false);
	let restoreMessage = $state<string | null>(null);
	let restoreError = $state<string | null>(null);

	let refCopied = $state(false);

	// Auto-select the first changed checkpoint once data arrives and nothing is
	// selected yet — mirrors the previous Code-tab default landing.
	$effect(() => {
		if (selectedCheckpointId) return;
		const first =
			visibleCheckpoints.find((checkpoint) => checkpoint.status === 'created') ??
			visibleCheckpoints[0] ??
			null;
		if (first) selectedCheckpointId = first.id;
	});

	// Load the diff whenever the selected checkpoint (or file within it) changes —
	// this fires for both internal clicks and external selection (timeline markers).
	let diffKey = $state<string | null>(null);
	$effect(() => {
		const id = selectedCheckpointId;
		const path = selectedPath;
		if (!id) {
			codeDiff = '';
			return;
		}
		const key = `${id}::${path ?? ''}`;
		if (key === diffKey) return;
		diffKey = key;
		void loadDiff(id, path);
	});

	async function loadDiff(checkpointId: string, filePath: string | null): Promise<void> {
		codeDiff = '';
		codeDiffError = null;
		restoreMessage = null;
		restoreError = null;
		codeDiffLoading = true;
		try {
			const result = await fetchCheckpointDiff(executionId, checkpointId, filePath);
			codeDiff = result.diff;
			codeDiffError = result.error;
		} catch (err) {
			codeDiffError = err instanceof Error ? err.message : 'Failed to load checkpoint diff';
		} finally {
			codeDiffLoading = false;
		}
	}

	function selectCheckpoint(checkpointId: string, filePath: string | null = null): void {
		selectedPath = filePath;
		selectedCheckpointId = checkpointId;
	}

	async function restoreSelected(): Promise<void> {
		if (!selectedCheckpoint) return;
		const sandboxName = selectedCheckpoint.sandboxName || activeSandboxName;
		if (!sandboxName) {
			restoreError = 'No active sandbox is available for restore.';
			return;
		}
		restorePending = true;
		restoreMessage = null;
		restoreError = null;
		try {
			const result = await restoreCheckpointToSandbox(
				executionId,
				selectedCheckpoint.id,
				sandboxName,
				selectedCheckpoint.repoPath
			);
			restoreMessage = `Restored ${shortSha(result.afterSha)} into ${result.sandboxName}.`;
		} catch (err) {
			restoreError = err instanceof Error ? err.message : 'Failed to restore checkpoint';
		} finally {
			restorePending = false;
		}
	}

	async function copyRef(): Promise<void> {
		const ref = selectedCheckpoint?.remoteRef;
		if (!ref) return;
		try {
			await navigator.clipboard.writeText(ref);
			refCopied = true;
			setTimeout(() => (refCopied = false), 1500);
		} catch {
			/* clipboard unavailable — no-op */
		}
	}
</script>

<div class="flex h-full flex-col gap-4">
	{#if !compact}
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<p class="text-sm font-medium">Workspace Checkpoints</p>
				<p class="text-xs text-muted-foreground">
					Git-backed checkpoints created after mutating agent tools. Dapr stores the references; diffs load on demand.
				</p>
			</div>
			<div class="flex flex-wrap items-center gap-2">
				<Badge variant="outline">{visibleCheckpoints.length} checkpoints</Badge>
				<Badge variant="outline">{changeCount} with changes</Badge>
				<Badge variant="outline">{durableCount} durable</Badge>
				{#if onRefresh}
					<button
						class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:cursor-progress disabled:opacity-60"
						type="button"
						disabled={loading}
						onclick={() => onRefresh?.()}
					>
						<RefreshCw size={12} class={loading ? 'animate-spin' : ''} />
						Refresh
					</button>
				{/if}
			</div>
		</div>
	{/if}

	{#if error}
		<Alert variant="destructive">
			<CircleAlert class="size-4" />
			<AlertDescription>{error}</AlertDescription>
		</Alert>
	{/if}

	{#if loading && visibleCheckpoints.length === 0}
		<div class="grid gap-3 lg:grid-cols-[22rem_1fr]">
			<Skeleton class="h-80 w-full rounded-md" />
			<Skeleton class="h-80 w-full rounded-md" />
		</div>
	{:else if visibleCheckpoints.length === 0}
		<div class="flex flex-1 flex-col items-center justify-center text-muted-foreground">
			<FileDiff size={24} />
			<p class="mt-2 text-sm font-medium">No code checkpoints recorded</p>
			<p class="mt-1 max-w-md text-center text-xs">
				New dapr-agent-py runs will checkpoint write, edit, patch, and shell tools when the workspace is backed by Git.
			</p>
		</div>
	{:else}
		<div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[24rem_minmax(0,1fr)]">
			<div class="min-h-0 overflow-y-auto rounded-md border border-border">
				{#each visibleCheckpoints as checkpoint (checkpoint.id)}
					{@const gitChangeLabel = checkpointGitChangeLabel(checkpoint)}
					{@const gitShaRange = checkpointShaRange(checkpoint)}
					{@const gitRemoteLabel = checkpointGitRemoteLabel(checkpoint)}
					<button
						type="button"
						class="block w-full border-b border-border px-3 py-3 text-left last:border-b-0 hover:bg-muted/70 {checkpoint.id === selectedCheckpointId ? 'bg-muted' : ''}"
						onclick={() => selectCheckpoint(checkpoint.id)}
					>
						<div class="flex items-center justify-between gap-2">
							<span class="truncate text-sm font-medium">{checkpoint.toolName}</span>
							{#if checkpoint.status === 'error'}
								<Badge variant="destructive" class="shrink-0 font-mono text-[10px]">!</Badge>
							{:else if gitChangeLabel}
								<Badge variant="outline" class="shrink-0 font-mono text-[10px]">{gitChangeLabel}</Badge>
							{/if}
						</div>
						{#if gitShaRange || gitRemoteLabel || (checkpoint.seq && (gitChangeLabel || checkpoint.status === 'error'))}
							<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-muted-foreground">
								{#if gitShaRange}
									<span>{gitShaRange}</span>
								{/if}
								{#if gitRemoteLabel}
									<span>{gitRemoteLabel}</span>
								{/if}
								{#if checkpoint.seq && (gitChangeLabel || checkpoint.status === 'error')}
									<span>#{checkpoint.seq}</span>
								{/if}
							</div>
						{/if}
						{#if checkpointShouldShowRemoteError(checkpoint)}
							<p class="mt-1 line-clamp-2 text-xs text-amber-600 dark:text-amber-400">{checkpoint.remoteError}</p>
						{/if}
						{#if checkpoint.error}
							<p class="mt-1 line-clamp-2 text-xs text-red-600 dark:text-red-400">{checkpoint.error}</p>
						{/if}
					</button>
				{/each}
			</div>

			<div class="flex min-h-0 flex-col overflow-hidden rounded-md border border-border">
				<div class="border-b border-border px-3 py-2">
					{#if selectedCheckpoint}
						<div class="flex flex-wrap items-center justify-between gap-2">
							<div class="min-w-0">
								<p class="truncate text-sm font-medium">
									{selectedPath ?? selectedCheckpoint.toolName}
								</p>
								<p class="truncate text-xs text-muted-foreground">
									{selectedCheckpoint.repoPath}
									{#if selectedCheckpoint.sandboxName}
										<span> · {selectedCheckpoint.sandboxName}</span>
									{/if}
									{#if selectedCheckpoint.remoteRef}
										<span> · {checkpointRemoteLabel(selectedCheckpoint)}</span>
									{/if}
								</p>
							</div>
							<div class="flex flex-wrap items-center gap-1">
								{#if onForkCheckpoint}
									<button
										type="button"
										class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
										onclick={() => onForkCheckpoint?.(selectedCheckpoint)}
										title="Fork a new run from this checkpoint's step"
									>
										<GitFork class="size-3" /> Fork from this checkpoint
									</button>
								{/if}
								{#if selectedCheckpoint.remoteRef}
									<button
										type="button"
										class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
										onclick={copyRef}
										title={`Copy pushed ref ${selectedCheckpoint.remoteRef}`}
									>
										{#if refCopied}
											<Check class="size-3 text-green-500" /> Copied
										{:else}
											<Copy class="size-3" /> Copy ref
										{/if}
									</button>
								{/if}
								{#if checkpointIsDurable(selectedCheckpoint)}
									<button
										type="button"
										class="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:cursor-progress disabled:opacity-60"
										disabled={restorePending}
										onclick={restoreSelected}
									>
										{restorePending ? 'Restoring...' : 'Restore to sandbox'}
									</button>
								{/if}
								{#each selectedCheckpoint.changedFiles as file (checkpointFilePath(file))}
									{@const path = checkpointFilePath(file)}
									{#if path}
										<button
											type="button"
											class="rounded-md border border-border px-2 py-1 text-xs hover:bg-muted {selectedPath === path ? 'bg-muted' : ''}"
											onclick={() => selectCheckpoint(selectedCheckpoint.id, path)}
										>
											<span class="font-mono text-muted-foreground">{checkpointFileStatusLabel(file)}</span>
											<span>{path}</span>
											{#if checkpointFileSummary(file)}
												<span class="ml-1 text-muted-foreground">{checkpointFileSummary(file)}</span>
											{/if}
										</button>
									{/if}
								{/each}
							</div>
						</div>
					{:else}
						<p class="text-sm text-muted-foreground">Select a checkpoint to inspect its diff.</p>
					{/if}
					{#if runHref}
						<a
							href={runHref}
							class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
						>
							Open in run page → Code tab <ExternalLink class="size-3" />
						</a>
					{/if}
					{#if restoreMessage}
						<p class="mt-2 text-xs text-green-700 dark:text-green-400">{restoreMessage}</p>
					{/if}
					{#if restoreError}
						<p class="mt-2 text-xs text-red-600 dark:text-red-400">{restoreError}</p>
					{/if}
				</div>

				<div class="min-h-0 flex-1 overflow-hidden">
					{#if codeDiffLoading}
						<div class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
							<Loader2 size={16} class="animate-spin" />
							Loading diff...
						</div>
					{:else if codeDiffError}
						<Alert variant="destructive" class="m-4">
							<CircleAlert class="size-4" />
							<AlertDescription>
								<pre class="whitespace-pre-wrap break-all font-mono text-xs">{codeDiffError}</pre>
							</AlertDescription>
						</Alert>
					{:else if codeDiffPatch}
						<div class="h-full overflow-auto p-2">
							<RenderedPatch patch={codeDiffPatch} layout="line-by-line" />
						</div>
					{:else}
						<div class="flex h-full flex-col items-center justify-center text-muted-foreground">
							<FileDiff size={22} />
							<p class="mt-2 text-sm">No diff for this checkpoint</p>
						</div>
					{/if}
				</div>
			</div>
		</div>
	{/if}
</div>

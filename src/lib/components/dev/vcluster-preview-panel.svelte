<script lang="ts">
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
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
	import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '$lib/components/ui/tooltip';
	import {
		Boxes,
		ChevronDown,
		ChevronRight,
		ExternalLink,
		GitPullRequest,
		Loader2,
		Moon,
		MoreHorizontal,
		Plus,
		ShieldCheck,
		Trash2,
		Zap
	} from '@lucide/svelte';
	import StatusPill from '$lib/components/shared/status-pill.svelte';
	import PoolCapacityMeter from '$lib/components/dev/pool-capacity-meter.svelte';
	import PreviewRunsPanel from '$lib/components/dev/preview-runs-panel.svelte';
	import { teardownConfirmMessage } from '$lib/components/dev/vcluster-preview-teardown-confirm';
	import {
		effectivePreviewStatus,
		expiresIn,
		relativeTime,
		sleepDisabledReason
	} from '$lib/components/dev/preview-lifecycle';
	import type { VclusterPreviewCounts, VclusterPreviewSummary } from '$lib/types/dev-previews';
	import {
		launchPreview,
		sleepPreview,
		teardownPreview,
		wakePreview
	} from '../../../routes/workspaces/[slug]/dev/data.remote';

	// Presentational: data (previews + counts) is fed by the hub page's query +
	// single 5s tick; the panel owns only the mutation commands and asks the
	// parent to refresh via onchanged().
	let {
		previews = [],
		counts = null,
		readProxyEnabled = false,
		slug,
		onchanged
	}: {
		previews?: VclusterPreviewSummary[];
		counts?: VclusterPreviewCounts | null;
		readProxyEnabled?: boolean;
		slug: string;
		onchanged?: () => void;
	} = $props();

	let name = $state('');
	let launching = $state(false);
	let errorMessage = $state<string | null>(null);
	let capacityAlert = $state<string | null>(null);
	let busy = $state<Record<string, string>>({});
	// Sticky "resuming…" until the woken preview reports awake again.
	let resuming = $state<Record<string, boolean>>({});
	let expandedRuns = $state<Record<string, boolean>>({});
	let toTeardown = $state<VclusterPreviewSummary | null>(null);

	const poolFree = $derived(counts?.free ?? 0);

	$effect(() => {
		// Clear the sticky wake marker once the preview is no longer slept.
		let changed = false;
		const next = { ...resuming };
		for (const p of previews) {
			if (next[p.name] && p.state !== 'slept') {
				delete next[p.name];
				changed = true;
			}
		}
		if (changed) resuming = next;
	});

	function setBusy(n: string, action: string) {
		busy = { ...busy, [n]: action };
	}
	function clearBusy(n: string) {
		const next = { ...busy };
		delete next[n];
		busy = next;
	}

	async function launch() {
		const n = name.trim();
		if (!n) return;
		launching = true;
		errorMessage = null;
		capacityAlert = null;
		try {
			const result = await launchPreview({ name: n });
			if (!result.ok) {
				capacityAlert = result.message;
				return;
			}
			name = '';
			onchanged?.();
		} catch (e) {
			errorMessage = e instanceof Error ? e.message : 'Launch failed';
		} finally {
			launching = false;
		}
	}

	async function doSleep(p: VclusterPreviewSummary) {
		setBusy(p.name, 'sleep');
		try {
			const r = await sleepPreview({ name: p.name });
			if (!r.ok) {
				toast.warning(`Can't sleep ${p.name}`, { description: r.message });
			} else {
				toast.success(`${p.name} is sleeping`);
				onchanged?.();
			}
		} catch (e) {
			toast.error('Sleep failed', { description: e instanceof Error ? e.message : String(e) });
		} finally {
			clearBusy(p.name);
		}
	}

	async function doWake(p: VclusterPreviewSummary) {
		setBusy(p.name, 'wake');
		try {
			await wakePreview({ name: p.name });
			resuming = { ...resuming, [p.name]: true };
			onchanged?.();
		} catch (e) {
			toast.error('Wake failed', { description: e instanceof Error ? e.message : String(e) });
		} finally {
			clearBusy(p.name);
		}
	}

	async function confirmTeardown() {
		const p = toTeardown;
		if (!p) return;
		toTeardown = null;
		setBusy(p.name, 'teardown');
		try {
			const { archive } = await teardownPreview({ name: p.name });
			if (archive && archive.archived) {
				const runs = archive.executionCount ?? 0;
				const bundles = archive.bundleCount ?? 0;
				toast.success(`Archived ${runs} run${runs === 1 ? '' : 's'} + ${bundles} bundle${bundles === 1 ? '' : 's'}`, {
					description: `Preview "${p.name}" torn down.`,
					action: {
						label: 'View archive',
						onClick: () => void goto(`/workspaces/${slug}/previews/archived/${encodeURIComponent(p.name)}`)
					}
				});
			} else if (archive && !archive.archived) {
				toast.warning(`Torn down — nothing archived`, {
					description: archive.reason ?? 'no runs or bundles to keep'
				});
			} else {
				toast.success(`Preview "${p.name}" torn down`);
			}
			onchanged?.();
		} catch (e) {
			toast.error('Teardown failed', { description: e instanceof Error ? e.message : String(e) });
		} finally {
			clearBusy(p.name);
		}
	}
</script>

<section class="rounded-xl border bg-card p-4 space-y-3">
	<div class="flex items-start gap-3">
		<div class="size-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
			<Boxes class="size-5 text-primary" />
		</div>
		<div class="min-w-0">
			<h2 class="text-base font-semibold">Full environments (vcluster)</h2>
			<p class="text-sm text-muted-foreground">
				A dev-primary vcluster running the whole stack (BFF + orchestrator + function-router) on
				its own database. Ryzen remains a canary/fallback path. Log in with
				<code class="text-xs">preview@local</code> / <code class="text-xs">preview-access</code>.
			</p>
		</div>
	</div>

	<PoolCapacityMeter {counts} />

	<div class="flex items-center gap-2">
		<input
			class="flex h-9 w-48 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
			placeholder="preview name (e.g. feat-x)"
			bind:value={name}
			onkeydown={(e) => e.key === 'Enter' && launch()}
			disabled={launching}
		/>
		<Button size="sm" onclick={launch} disabled={launching || !name.trim()}>
			{#if launching}<Loader2 class="size-4 animate-spin" />{:else if poolFree > 0}<Zap
					class="size-4"
				/>{:else}<Plus class="size-4" />{/if}
			Launch
		</Button>
		{#if poolFree > 0}
			<span
				class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
				title="A warm vcluster is pre-baked — your launch is claimed instantly instead of a multi-minute cold provision"
			>
				<Zap class="size-3" /> {poolFree} warm
			</span>
		{/if}
	</div>

	{#if errorMessage}
		<p class="text-sm text-destructive">{errorMessage}</p>
	{/if}

	{#if capacityAlert}
		<Alert variant="destructive">
			<AlertDescription>
				{capacityAlert} — see the capacity meter above; sleep or tear down a preview to free a slot.
			</AlertDescription>
		</Alert>
	{/if}

	{#if previews.length > 0}
		<ul class="divide-y rounded-lg border">
			{#each previews as p (p.name)}
				{@const sleepReason = sleepDisabledReason(p)}
				{@const expiry = expiresIn(p.expiresAt)}
				{@const lastActive = relativeTime(p.lastActive)}
				<li class="px-3 py-2 space-y-1">
					<div class="flex items-center justify-between gap-3">
						<div class="flex items-center gap-2 min-w-0 flex-wrap">
							{#if readProxyEnabled && p.ready}
								<button
									type="button"
									class="shrink-0 text-muted-foreground hover:text-foreground"
									onclick={() =>
										(expandedRuns = { ...expandedRuns, [p.name]: !expandedRuns[p.name] })}
									title="Recent runs"
								>
									{#if expandedRuns[p.name]}<ChevronDown class="size-4" />{:else}<ChevronRight
											class="size-4"
										/>{/if}
								</button>
							{/if}
							<span class="font-medium truncate">{p.name}</span>

							{#if resuming[p.name]}
								<StatusPill status="resuming" label="Resuming…" />
							{:else}
								<StatusPill status={effectivePreviewStatus(p)} />
							{/if}
							{#if p.state === 'slept'}<Moon class="size-3.5 text-amber-500" />{/if}

							{#if p.protected}
								<TooltipProvider>
									<Tooltip>
										<TooltipTrigger>
											<ShieldCheck class="size-3.5 text-emerald-500" />
										</TooltipTrigger>
										<TooltipContent>
											<p class="max-w-[220px] text-xs">
												Protected — exempt from sleep, eviction and the TTL reaper.
											</p>
										</TooltipContent>
									</Tooltip>
								</TooltipProvider>
							{/if}

							{#if p.origin === 'pr' && p.prNumber != null}
								<a
									href={p.prUrl ?? '#'}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground"
								>
									<GitPullRequest class="size-3" /> PR #{p.prNumber}
								</a>
							{:else if p.origin}
								<span class="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{p.origin}</span>
							{/if}

							{#if p.pool}
								<span
									class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
									title="Claimed instantly from the warm pool ({p.pool})"
								>
									<Zap class="size-3" /> pooled
								</span>
							{/if}
						</div>

						<div class="flex items-center gap-1 shrink-0">
							{#if p.ready && p.url}
								<a
									href={p.url}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 text-sm text-primary hover:underline"
								>
									Open <ExternalLink class="size-3.5" />
								</a>
							{/if}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger
									class="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
									disabled={!!busy[p.name]}
									aria-label="Preview actions"
								>
									{#if busy[p.name]}<Loader2 class="size-4 animate-spin" />{:else}<MoreHorizontal
											class="size-4"
										/>{/if}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									{#if p.state === 'slept'}
										<DropdownMenu.Item onclick={() => doWake(p)}>
											<Zap class="size-4" /> Wake
										</DropdownMenu.Item>
									{:else}
										<DropdownMenu.Item
											disabled={!!sleepReason}
											onclick={() => !sleepReason && doSleep(p)}
											title={sleepReason ?? undefined}
										>
											<Moon class="size-4" /> Sleep
										</DropdownMenu.Item>
										{#if sleepReason}
											<p class="px-2 pb-1 text-[10px] text-muted-foreground max-w-[200px]">{sleepReason}</p>
										{/if}
									{/if}
									{#if readProxyEnabled && p.ready}
										<DropdownMenu.Item
											onclick={() =>
												(expandedRuns = { ...expandedRuns, [p.name]: !expandedRuns[p.name] })}
										>
											<ChevronDown class="size-4" /> Recent runs
										</DropdownMenu.Item>
									{/if}
									<DropdownMenu.Separator />
									<DropdownMenu.Item
										class="text-destructive focus:text-destructive"
										onclick={() => (toTeardown = p)}
									>
										<Trash2 class="size-4" /> Tear down
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</div>
					</div>

					<div class="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[11px] text-muted-foreground pl-0.5">
						{#if lastActive}<span>active {lastActive}</span>{/if}
						{#if expiry}
							<span class={expiry.urgent ? 'text-amber-600 dark:text-amber-400' : ''}>{expiry.label}</span>
						{/if}
						<span>{p.targetCluster}</span>
					</div>

					{#if readProxyEnabled && p.ready && expandedRuns[p.name]}
						<div class="mt-1">
							<PreviewRunsPanel name={p.name} url={p.url} />
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<AlertDialog open={toTeardown !== null} onOpenChange={(open) => !open && (toTeardown = null)}>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Tear down preview "{toTeardown?.name}"?</AlertDialogTitle>
			<AlertDialogDescription class="whitespace-pre-line">
				{toTeardown ? teardownConfirmMessage(toTeardown) : ''}
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={confirmTeardown}>Tear down</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

<script lang="ts">
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { NativeSelect, NativeSelectOption } from '$lib/components/ui/native-select';
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
		previewNativeServices = [],
		readProxyEnabled = false,
		slug,
		onchanged
	}: {
		previews?: VclusterPreviewSummary[];
		counts?: VclusterPreviewCounts | null;
		previewNativeServices?: readonly string[];
		readProxyEnabled?: boolean;
		slug: string;
		onchanged?: () => void;
	} = $props();

	let name = $state('');
	let profile = $state<'app-live' | 'manifest-candidate'>('app-live');
	let platformRevision = $state('');
	let sourceRevision = $state('');
	let pullRequestNumber = $state('');
	let ttlHours = $state(24);
	let selectedServices = $state<Record<string, boolean>>({});
	let launching = $state(false);
	let errorMessage = $state<string | null>(null);
	let capacityAlert = $state<string | null>(null);
	let busy = $state<Record<string, string>>({});
	// Sticky "resuming…" until the woken preview reports awake again.
	let resuming = $state<Record<string, boolean>>({});
	let expandedRuns = $state<Record<string, boolean>>({});
	let toTeardown = $state<VclusterPreviewSummary | null>(null);
	let toForceTeardown = $state<VclusterPreviewSummary | null>(null);

	const selectedPreviewServices = $derived(
		previewNativeServices.filter((service) => selectedServices[service] !== false)
	);

	$effect(() => {
		const next = { ...selectedServices };
		let changed = false;
		for (const service of previewNativeServices) {
			if (!(service in next)) {
				next[service] = true;
				changed = true;
			}
		}
		for (const service of Object.keys(next)) {
			if (!previewNativeServices.includes(service)) {
				delete next[service];
				changed = true;
			}
		}
		if (changed) selectedServices = next;
	});

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
	function shortRevision(value: string | null): string | null {
		return value ? value.slice(0, 12) : null;
	}
	function provenanceValue(p: VclusterPreviewSummary, key: string): string | null {
		const value = p.provenance?.[key];
		return typeof value === 'string' && value ? value : null;
	}
	function repositoryProvenance(p: VclusterPreviewSummary): string | null {
		const platform = provenanceValue(p, 'platformRepository');
		const source = provenanceValue(p, 'sourceRepository');
		return platform && source ? `${platform} / ${source}` : (platform ?? source);
	}

	async function launch() {
		const n = name.trim();
		if (!n) return;
		if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168) {
			errorMessage = 'TTL must be an integer from 1 to 168 hours';
			return;
		}
		if (profile === 'app-live' && selectedPreviewServices.length === 0) {
			errorMessage = 'Select at least one preview-native service';
			return;
		}
		const infrastructurePr = Number(pullRequestNumber);
		if (
			profile === 'manifest-candidate' &&
			(!Number.isInteger(infrastructurePr) || infrastructurePr < 1)
		) {
			errorMessage = 'Enter a valid stacks pull request number';
			return;
		}
		launching = true;
		errorMessage = null;
		capacityAlert = null;
		try {
			const platform = platformRevision.trim();
			const source = sourceRevision.trim();
			const result = await launchPreview({
				name: n,
				profile,
					services: profile === 'app-live' ? selectedPreviewServices : [],
					ttlHours,
				allocation: { kind: 'cold' },
				...(profile === 'manifest-candidate'
					? { pullRequest: { number: infrastructurePr } }
					: {}),
				...(platform
					? /^[0-9a-f]{40}$/i.test(platform)
						? { platformRevision: platform.toLowerCase() }
						: { platformRef: platform }
					: {}),
				...(source
					? /^[0-9a-f]{40}$/i.test(source)
						? { sourceRevision: source.toLowerCase() }
						: { sourceRef: source }
					: {})
			});
			if (!result.ok) {
				capacityAlert = result.message;
				return;
			}
			name = '';
			pullRequestNumber = '';
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
			const detail = e instanceof Error ? e.message : String(e);
			if (
				p.profile === 'app-live' &&
				p.mode === 'live' &&
				!p.ready &&
				detail.toLowerCase().includes('archive')
			) {
				toForceTeardown = p;
				toast.warning('Preview archive is unavailable', {
					description: 'Review the loss-accounted teardown confirmation.'
				});
			} else {
				toast.error('Teardown failed', { description: detail });
			}
		} finally {
			clearBusy(p.name);
		}
	}

	async function confirmForceTeardown() {
		const p = toForceTeardown;
		if (!p) return;
		toForceTeardown = null;
		setBusy(p.name, 'teardown');
		try {
			const { archive } = await teardownPreview({ name: p.name, forceFailed: true });
			if (!archive?.quarantined) throw new Error('Loss-accounting receipt was not returned');
			toast.success(`Preview "${p.name}" teardown started`, {
				description: 'A durable quarantine summary recorded the incomplete archive.'
			});
			onchanged?.();
		} catch (e) {
			toast.error('Failed-preview teardown refused', {
				description: e instanceof Error ? e.message : String(e)
			});
		} finally {
			clearBusy(p.name);
		}
	}
</script>

<section class="space-y-3 border-y py-4">
	<div class="flex items-start gap-3">
		<div class="size-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
			<Boxes class="size-5 text-primary" />
		</div>
		<div class="min-w-0">
			<h2 class="text-base font-semibold">Full environments (vCluster)</h2>
		</div>
	</div>

	<PoolCapacityMeter {counts} />

	<div class="grid gap-3 rounded-md border bg-muted/20 p-3 lg:grid-cols-[minmax(10rem,1fr)_12rem_7rem_auto]">
		<label class="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
			Name
			<input
				class="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				placeholder="feat-x"
				bind:value={name}
				onkeydown={(e) => e.key === 'Enter' && launch()}
				disabled={launching}
			/>
		</label>
		<label class="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
			Profile
			<NativeSelect bind:value={profile} class="w-full" disabled={launching}>
				<NativeSelectOption value="app-live">App live</NativeSelectOption>
				<NativeSelectOption value="manifest-candidate">Infrastructure PR</NativeSelectOption>
			</NativeSelect>
		</label>
		<label class="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground">
			TTL (hours)
			<input
				type="number"
				min="1"
				max="168"
				step="1"
				class="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm tabular-nums text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				bind:value={ttlHours}
				disabled={launching}
			/>
		</label>
		<div class="flex items-end gap-2">
			<Button
				size="sm"
				onclick={launch}
				disabled={launching || !name.trim() || !Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > 168 || (profile === 'app-live' && selectedPreviewServices.length === 0)}
			>
				{#if launching}<Loader2 class="size-4 animate-spin" />{:else}<Plus class="size-4" />{/if}
				Launch
			</Button>
		</div>
		{#if profile === 'manifest-candidate'}
			<label class="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground lg:col-span-4">
				Stacks PR
				<input
					class="h-9 min-w-0 rounded-md border border-input bg-background px-3 font-mono text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					inputmode="numeric"
					placeholder="123"
					bind:value={pullRequestNumber}
					disabled={launching}
				/>
			</label>
		{:else}
		<label class="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground lg:col-span-2">
			Stacks revision
			<input
				class="h-9 min-w-0 rounded-md border border-input bg-background px-3 font-mono text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				placeholder="main or full commit SHA"
				bind:value={platformRevision}
				disabled={launching}
			/>
		</label>
		<label class="grid min-w-0 gap-1 text-xs font-medium text-muted-foreground lg:col-span-2">
			Source revision
			<input
				class="h-9 min-w-0 rounded-md border border-input bg-background px-3 font-mono text-xs text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				placeholder="main or full commit SHA"
				bind:value={sourceRevision}
				disabled={launching}
			/>
		</label>
		{/if}
		{#if profile === 'app-live'}
			<fieldset class="flex min-w-0 flex-wrap gap-x-4 gap-y-2 lg:col-span-4">
				<legend class="mb-1 text-xs font-medium text-muted-foreground">Live services</legend>
				{#each previewNativeServices as service (service)}
					<label class="inline-flex items-center gap-2 text-xs text-foreground">
						<input
							type="checkbox"
							class="size-4 rounded border-input accent-primary"
							checked={selectedServices[service] !== false}
							onchange={(event) =>
								(selectedServices = {
									...selectedServices,
									[service]: event.currentTarget.checked
								})}
							disabled={launching}
						/>
						{service}
					</label>
				{/each}
			</fieldset>
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

							{#if (p.origin?.kind === 'pull-request' || p.legacyOrigin === 'pr') && p.prNumber != null}
								<a
									href={p.prUrl ?? '#'}
									target="_blank"
									rel="noopener noreferrer"
									class="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground hover:text-foreground"
								>
									<GitPullRequest class="size-3" /> PR #{p.prNumber}
								</a>
							{:else if p.origin?.kind || p.legacyOrigin}
								<span class="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
									>{p.origin?.kind ?? p.legacyOrigin}</span
								>
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

					<div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 pl-0.5 text-[11px] text-muted-foreground">
						{#if p.profile}<span>{p.profile}</span>{/if}
						{#if p.lane || p.mode}<span>{[p.lane, p.mode].filter(Boolean).join(' / ')}</span>{/if}
						{#if shortRevision(p.platformRevision)}
							<span title={p.platformRevision ?? undefined}>platform <code class="font-mono">{shortRevision(p.platformRevision)}</code></span>
						{/if}
						{#if shortRevision(p.sourceRevision)}
							<span title={p.sourceRevision ?? undefined}>source <code class="font-mono">{shortRevision(p.sourceRevision)}</code></span>
						{/if}
						{#if p.owner}
							<span class="max-w-[18rem] truncate" title={`${p.owner.kind}:${p.owner.id}`}>owner {p.owner.kind}:{p.owner.id}</span>
						{/if}
					</div>

					<div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 pl-0.5 text-[11px] text-muted-foreground">
						{#if p.services?.length}
							<span class="max-w-full truncate" title={p.services.join(', ')}>services {p.services.join(', ')}</span>
						{/if}
						{#if p.catalogDigest}
							<span title={p.catalogDigest}>catalog <code class="font-mono">{p.catalogDigest.replace(/^sha256:/, '').slice(0, 12)}</code></span>
						{/if}
						{#if repositoryProvenance(p)}
							<span class="max-w-full truncate" title={repositoryProvenance(p) ?? undefined}>{repositoryProvenance(p)}</span>
						{/if}
						{#if provenanceValue(p, 'requestId')}
							<span title={provenanceValue(p, 'requestId') ?? undefined}>request <code class="font-mono">{provenanceValue(p, 'requestId')?.slice(0, 12)}</code></span>
						{/if}
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
				{toTeardown
					? teardownConfirmMessage({
							name: toTeardown.name,
							pool: toTeardown.pool,
							origin:
								toTeardown.origin?.kind === 'pull-request'
									? 'pr'
									: (toTeardown.origin?.kind ?? toTeardown.legacyOrigin)
						})
					: ''}
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={confirmTeardown}>Tear down</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

<AlertDialog
	open={toForceTeardown !== null}
	onOpenChange={(open) => !open && (toForceTeardown = null)}
>
	<AlertDialogContent>
		<AlertDialogHeader>
			<AlertDialogTitle>Record archive loss and tear down "{toForceTeardown?.name}"?</AlertDialogTitle>
			<AlertDialogDescription>
				The preview is unhealthy and its archive could not be completed. This records a durable
				quarantine summary before requesting guarded teardown. Unarchived preview data will be lost.
			</AlertDialogDescription>
		</AlertDialogHeader>
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={confirmForceTeardown}>Record loss and tear down</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

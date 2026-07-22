<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount, untrack } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
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
	import {
		AlertTriangle,
		ArrowLeft,
		CheckCircle2,
		Circle,
		GitPullRequest,
		Loader2,
		SendHorizontal,
		XCircle
	} from '@lucide/svelte';
	import DevPreviewStatusCard from '$lib/components/dev/dev-preview-status-card.svelte';
	import DevServiceCard from '$lib/components/dev/dev-service-card.svelte';
	import CodeVersionsPanel from '$lib/components/dev/code-versions-panel.svelte';
	import SyncGenerationTimeline from '$lib/components/dev/sync-generation-timeline.svelte';
	import type { SyncTimelineVersionInput } from '$lib/components/dev/sync-generation-timeline';
	import type { DevEnvironmentSummary } from '$lib/components/dev/dev-environment-card.svelte';
	import StatusPill from '$lib/components/shared/status-pill.svelte';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';
	import SessionGoalBadge from '$lib/components/sessions/session-goal-badge.svelte';
	import {
		deriveDevExecutionLifecycle,
		type DevExecutionLifecycleState
	} from '$lib/dev/dev-execution-lifecycle';
	import {
		DevEnvironmentTeardownBlockedError,
		pendingDevEnvironmentTeardowns,
		teardownDevEnvironmentUntilComplete,
		type DevEnvironmentTeardownProgress
	} from '$lib/dev-environment-teardown';
	import { getDevEnvironment, getSidecarStatus } from './data.remote';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');

	// SSR-seeded so there's no blank flash; the query hydrates and a single
	// visibility-gated 5s tick keeps it fresh (replacing the old 4s interval).
	// Keep the remote query handle stable; its `current` property is reactive and
	// updates the derived environment and services after every refresh.
	const initialExecutionId = untrack(() => data.environment.executionId);
	const envQuery = getDevEnvironment(initialExecutionId);
	const environment = $derived<DevEnvironmentSummary>(
		envQuery.current?.environment ?? data.environment
	);
	const services = $derived<DevEnvironmentSummary[]>(
		envQuery.current?.services ?? data.services ?? [data.environment]
	);

	let errorMessage = $state<string | null>(null);
	let confirmTeardown = $state(false);
	let captureBlockedMessage = $state<string | null>(null);
	let busy = $state(false);
	let teardownProgress = $state<DevEnvironmentTeardownProgress | null>(null);
	let teardownDiscardUncaptured = $state(false);
	let operationNotice = $state<string | null>(null);
	let teardownReloadReturnUrl: string | null = null;
	// Code versions this run produced that haven't been pushed to a GitHub PR yet.
	let outstandingVersions = $state(0);
	// Version artifacts mirrored from the checkpoints panel's load (single read)
	// so the sync-generation timeline can render without a second poll.
	let timelineVersions = $state<SyncTimelineVersionInput[]>([]);
	let timelineLoaded = $state(false);
	let canManageStrictCheckpoints = $state(false);
	let serviceCheckpointStates = $state<
		Record<string, 'unknown' | 'writable' | 'preparing' | 'frozen'>
	>({});
	let teardownSourceLocked = $state(false);
	let sourceProbeEpoch = 0;
	let sourceProbeInFlight: { epoch: number; task: Promise<void> } | null = null;

	// Composer
	let composer = $state('');
	let sending = $state(false);

	const sessionId = $derived(environment.sessionId);
	const environmentLabel = $derived(
		services.length > 1 ? services.map((service) => service.service).join(' + ') : environment.service
	);
	const lifecycle = $derived.by(() =>
		deriveDevExecutionLifecycle({
			executionId: environment.executionId,
			runStatus: environment.runStatus,
			sessionId,
			services
		})
	);
	const sourceCheckpointState = $derived.by<
		'unknown' | 'writable' | 'preparing' | 'frozen'
	>(() => {
		const states = services.map((service) => serviceCheckpointStates[service.service] ?? 'unknown');
		if (states.includes('frozen')) return 'frozen';
		if (states.includes('preparing')) return 'preparing';
		if (states.includes('unknown')) return 'unknown';
		return 'writable';
	});
	const sourceReadOnly = $derived(
		busy || teardownSourceLocked || sourceCheckpointState !== 'writable'
	);

	function lifecycleIconClass(state: DevExecutionLifecycleState): string {
		if (state === 'complete') return 'text-emerald-600 dark:text-emerald-400';
		if (state === 'active') return 'text-amber-600 dark:text-amber-400';
		if (state === 'failed') return 'text-destructive';
		return 'text-muted-foreground/50';
	}

	function teardownProgressMessage(
		progress: DevEnvironmentTeardownProgress,
		discardUncaptured: boolean
	): string {
		switch (progress) {
			case 'submitting':
				return discardUncaptured
					? 'Discarding uncaptured changes and starting cleanup…'
					: 'Preserving the latest live-sync generation in the stable draft PR…';
			case 'reconciling':
				return 'Connection changed. Verifying the durable teardown receipt…';
			case 'pending':
				return discardUncaptured
					? 'Discard accepted. Finalizing workload and session cleanup…'
					: 'Checkpoint accepted. Finalizing workload and session cleanup…';
			case 'complete':
				return 'Cleanup confirmed. Returning to Development…';
		}
	}

	function armTeardownReloadFallback() {
		if (typeof window === 'undefined' || teardownReloadReturnUrl) return;
		teardownReloadReturnUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
		window.history.replaceState(window.history.state, '', `/workspaces/${slug}/dev`);
	}

	function restoreTeardownDetailUrl() {
		if (typeof window === 'undefined' || !teardownReloadReturnUrl) return;
		window.history.replaceState(window.history.state, '', teardownReloadReturnUrl);
		teardownReloadReturnUrl = null;
	}

	function updateServiceCheckpointState(
		service: string,
		state: 'unknown' | 'writable' | 'preparing' | 'frozen'
	) {
		const current = untrack(() => serviceCheckpointStates);
		if (current[service] === state) return;
		serviceCheckpointStates = { ...current, [service]: state };
	}

	$effect(() => {
		if (typeof document === 'undefined') return;
		let timer: ReturnType<typeof setInterval> | null = null;
		const start = () => {
			if (timer === null) timer = setInterval(() => void envQuery.refresh(), 5000);
		};
		const stop = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const onVisibility = () => {
			if (document.visibilityState === 'visible') {
				void envQuery.refresh();
				start();
			} else {
				stop();
			}
		};
		onVisibility();
		document.addEventListener('visibilitychange', onVisibility);
		return () => {
			stop();
			document.removeEventListener('visibilitychange', onVisibility);
		};
	});

	function probeSourceCheckpointState(): Promise<void> {
		const epoch = sourceProbeEpoch;
		if (sourceProbeInFlight?.epoch === epoch) return sourceProbeInFlight.task;
		const task = (async () => {
			const snapshot = [...services];
			const entries = await Promise.all(
				snapshot.map(async (service) => {
					const query = getSidecarStatus({
						executionId: environment.executionId,
						service: service.service
					});
					try {
						await query.refresh();
						const view = await query;
						const state =
							view.status.ok && view.status.data.frozen
								? 'frozen'
								: view.status.ok && view.status.data.prepared
									? 'preparing'
									: view.status.ok
										? 'writable'
										: 'unknown';
						return [service.service, state] as const;
					} catch {
						return [service.service, 'unknown'] as const;
					}
				})
			);
			if (epoch !== sourceProbeEpoch) return;
			serviceCheckpointStates = Object.fromEntries(entries);
			if (!busy && entries.length > 0 && entries.every(([, state]) => state === 'writable')) {
				teardownSourceLocked = false;
			}
		})();
		const probe = { epoch, task };
		sourceProbeInFlight = probe;
		return task.finally(() => {
			if (sourceProbeInFlight === probe) sourceProbeInFlight = null;
		});
	}

	$effect(() => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const tick = async () => {
			await probeSourceCheckpointState();
			if (!stopped) timer = setTimeout(tick, 1500);
		};
		void tick();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	});

	async function send() {
		const text = composer.trim();
		if (!text || !sessionId || sending || sourceReadOnly) return;
		sending = true;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/events`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					events: [{ type: 'user.message', content: [{ type: 'text', text }] }]
				})
			});
			if (!res.ok) {
				errorMessage = `Send failed (${res.status})`;
				return;
			}
			composer = '';
			errorMessage = null;
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			sending = false;
		}
	}

	function onComposerKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
			e.preventDefault();
			void send();
		}
	}

	async function teardown(discardUncaptured = false) {
		if (busy) return;
		confirmTeardown = false;
		errorMessage = null;
		operationNotice = null;
		teardownProgress = null;
		teardownDiscardUncaptured = discardUncaptured;
		sourceProbeEpoch += 1;
		teardownSourceLocked = true;
		serviceCheckpointStates = Object.fromEntries(
			services.map((service) => [service.service, 'unknown'] as const)
		);
		busy = true;
		let completed = false;
		try {
			await teardownDevEnvironmentUntilComplete(environment.executionId, {
				discardUncaptured,
				onProgress: (progress) => {
					teardownProgress = progress;
					if (progress === 'submitting') armTeardownReloadFallback();
				}
			});
			completed = true;
			errorMessage = null;
			operationNotice = 'Cleanup is confirmed. Returning to Development…';
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
			if (teardownProgress === 'submitting') restoreTeardownDetailUrl();
			if (error instanceof DevEnvironmentTeardownBlockedError) {
				captureBlockedMessage = error.message;
				confirmTeardown = true;
			}
		} finally {
			sourceProbeEpoch += 1;
			busy = false;
			teardownProgress = null;
			if (!completed && teardownSourceLocked) await probeSourceCheckpointState();
		}

		if (completed) {
			if (typeof window !== 'undefined' && teardownReloadReturnUrl) {
				window.location.replace(`/workspaces/${slug}/dev`);
				return;
			}
			try {
				await goto(`/workspaces/${slug}/dev`);
			} catch {
				operationNotice =
					'Cleanup is confirmed, but Development could not load. Reload this page to continue.';
			}
		}
	}

	onMount(() => {
		const pending = pendingDevEnvironmentTeardowns().find(
			(item) => item.executionId === initialExecutionId
		);
		if (pending) void teardown(pending.discardUncaptured);
	});
</script>

<svelte:head>
	<title>{environmentLabel} · Dev environment · Workflow Builder</title>
</svelte:head>

<div class="flex h-full min-h-0 flex-col overflow-hidden">
	<header class="flex flex-wrap items-center gap-3 border-b px-4 py-3 sm:px-5">
		<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/dev`)}>
			<ArrowLeft class="size-4" /> Dev
		</Button>
		<div class="min-w-0 flex-1">
			<h1 class="truncate font-semibold" title={environmentLabel}>{environmentLabel}</h1>
			<p class="truncate text-xs text-muted-foreground" title={environment.executionId}>
				{services.length} service{services.length === 1 ? '' : 's'} · run
				<code>{environment.executionId.slice(0, 8)}</code>
			</p>
			<p class="text-xs text-muted-foreground">Live sync verified: archapp-0715b-hmr-1</p>
		</div>
		<StatusPill status={lifecycle.effectiveStatus} spinner={false} />
		{#if sessionId}
			<SessionGoalBadge {sessionId} />
		{/if}
	</header>

	{#if errorMessage}
		<div class="px-5 pt-3">
			<Alert variant="destructive">
				<AlertDescription>{errorMessage}</AlertDescription>
			</Alert>
		</div>
	{/if}
	{#if operationNotice}
		<div class="px-5 pt-3">
			<Alert>
				<CheckCircle2 class="size-4 text-emerald-600 dark:text-emerald-400" />
				<AlertDescription role="status" aria-live="polite">
					{operationNotice}
				</AlertDescription>
			</Alert>
		</div>
	{/if}
	{#if busy && teardownProgress}
		<div class="px-5 pt-3">
			<Alert>
				<Loader2 class="size-4 motion-safe:animate-spin" />
				<AlertDescription role="status" aria-live="polite" aria-atomic="true">
					{teardownProgressMessage(teardownProgress, teardownDiscardUncaptured)}
				</AlertDescription>
			</Alert>
		</div>
	{/if}
	{#if sourceCheckpointState === 'frozen' || sourceCheckpointState === 'preparing'}
		<div class="px-5 pt-3">
			<Alert>
				<AlertTriangle class="size-4" />
				<AlertDescription>
					{sourceCheckpointState === 'frozen'
						? 'Source writes are frozen while the stable draft PR is recovered. Retry teardown to continue the same checkpoint operation.'
						: 'Source writes are briefly paused while every service prepares one coherent checkpoint generation.'}
				</AlertDescription>
			</Alert>
		</div>
	{/if}

	<section class="border-b bg-muted/20 px-4 py-3 sm:px-5" aria-labelledby="lifecycle-heading">
		<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
			<h2 id="lifecycle-heading" class="text-xs font-semibold uppercase text-muted-foreground">
				Environment lifecycle
			</h2>
			<p class="text-xs text-muted-foreground" role="status" aria-live="polite" aria-atomic="true">
				{lifecycle.summary}
			</p>
		</div>
		<ol class="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-4">
			{#each lifecycle.stages as stage (stage.label)}
				<li
					class="min-h-16 bg-background px-3 py-2"
					aria-current={stage.state === 'active' ? 'step' : undefined}
					aria-label={`${stage.label}: ${stage.state}. ${stage.detail}`}
				>
					<div class="flex items-center gap-2">
						{#if stage.state === 'complete'}
							<CheckCircle2 class="size-4 shrink-0 {lifecycleIconClass(stage.state)}" />
						{:else if stage.state === 'active'}
							<Loader2
								class="size-4 shrink-0 motion-safe:animate-spin {lifecycleIconClass(stage.state)}"
							/>
						{:else if stage.state === 'failed'}
							<XCircle class="size-4 shrink-0 {lifecycleIconClass(stage.state)}" />
						{:else}
							<Circle class="size-4 shrink-0 {lifecycleIconClass(stage.state)}" />
						{/if}
						<span class="text-xs font-medium">{stage.label}</span>
					</div>
					<p class="mt-1 pl-6 text-[11px] text-muted-foreground">{stage.detail}</p>
				</li>
			{/each}
		</ol>
	</section>

	<div
		class="min-h-0 flex-1 overflow-y-auto lg:grid lg:grid-cols-[340px_minmax(0,1fr)] lg:overflow-hidden"
	>
		<!-- Status / controls column -->
		<aside class="space-y-4 border-b p-4 lg:overflow-y-auto lg:border-r lg:border-b-0">
			<DevPreviewStatusCard
				{environment}
				{busy}
				canTeardown={canManageStrictCheckpoints}
				onteardown={() => {
					captureBlockedMessage = null;
					confirmTeardown = true;
				}}
			/>
			<!-- B5: per-service card grid (health, sidecar status, run commands). -->
			<section class="space-y-2">
				<h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Services ({services.length})
				</h2>
				{#each services as svc (svc.service)}
					<DevServiceCard
						service={svc}
						{sourceReadOnly}
						oncheckpointstate={updateServiceCheckpointState}
					/>
				{/each}
			</section>
			<CodeVersionsPanel
				executionId={environment.executionId}
				services={services.map((service) => service.service)}
				live={!lifecycle.runTerminal}
				sourceReadOnly={sourceReadOnly}
				onoutstanding={(n) => (outstandingVersions = n)}
				oncapability={(allowed) => (canManageStrictCheckpoints = allowed)}
				onversions={(loaded) => {
					timelineVersions = loaded;
					timelineLoaded = true;
				}}
			/>
			<SyncGenerationTimeline versions={timelineVersions} loading={!timelineLoaded} />
		</aside>

		<!-- Interactive session column -->
		<section class="flex min-h-[38rem] flex-col lg:min-h-0">
			{#if sessionId}
				<div class="flex-1 min-h-0 overflow-hidden">
					<SessionTranscript {sessionId} showPulse showTimeline class="h-full" />
				</div>
				<div class="border-t p-3">
					<div class="flex items-end gap-2">
						<Textarea
							id="agent-message"
							class="min-h-[44px] max-h-40 resize-none"
							bind:value={composer}
							onkeydown={onComposerKeydown}
							disabled={sending || sourceReadOnly}
							placeholder={sourceReadOnly
								? sourceCheckpointState === 'unknown'
									? 'Checking source receiver state…'
									: 'Source writes are paused for checkpoint recovery'
								: 'Message the coding agent…'}
							aria-label="Message the coding agent"
						/>
						<Button
							onclick={send}
							disabled={sending || sourceReadOnly || !composer.trim()}
							aria-label={sending ? 'Sending message' : 'Send message'}
							title={sending ? 'Sending message' : 'Send message'}
						>
							<SendHorizontal class="size-4" />
						</Button>
					</div>
				</div>
			{:else}
				<div
					class="flex flex-1 flex-col items-center justify-center space-y-2 p-8 text-center"
					role="status"
					aria-live="polite"
				>
					<Loader2 class="size-5 text-amber-600 motion-safe:animate-spin dark:text-amber-400" />
					<p class="text-sm text-muted-foreground">
						Waiting for the interactive session to start…
					</p>
					<p class="text-xs text-muted-foreground">
						The workflow hands off into a coding-agent session once the preview is provisioned.
					</p>
				</div>
			{/if}
		</section>
	</div>
</div>

<AlertDialog open={confirmTeardown} onOpenChange={(open) => (confirmTeardown = open)}>
	<AlertDialogContent>
		<AlertDialogHeader>
		<AlertDialogTitle>Tear down {environmentLabel}?</AlertDialogTitle>
			<AlertDialogDescription>
				Pauses source writes across every service, verifies one live-sync generation, updates this
				execution's stable draft pull request, then stops the dev workload and interactive session.
				If checkpoint handoff fails after the freeze commits, the environment remains read-only so
				the same operation can be retried.
			</AlertDialogDescription>
		</AlertDialogHeader>
		{#if captureBlockedMessage}
			<div
				class="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
				role="alert"
			>
				<AlertTriangle class="mt-0.5 size-4 shrink-0" />
				<p>
					{captureBlockedMessage} Retry checkpointing to preserve the frozen source, or discard it
					as a platform administrator.
				</p>
			</div>
		{/if}
		{#if outstandingVersions > 0}
			<div
				class="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
			>
				<AlertTriangle class="mt-0.5 size-4 shrink-0" />
				<p>
					{outstandingVersions} code version{outstandingVersions === 1 ? '' : 's'} from this run
					{outstandingVersions === 1 ? 'is' : 'are'} waiting for a GitHub PR. The current
					whole-state checkpoint will be preserved in the draft pull request before teardown;
					promote older independent bundles separately when needed.
				</p>
			</div>
		{/if}
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			{#if captureBlockedMessage && canManageStrictCheckpoints}
				<Button variant="destructive" onclick={() => teardown(true)}>
					Discard changes and tear down
				</Button>
			{/if}
				<AlertDialogAction onclick={() => teardown(false)}>
					<GitPullRequest class="size-4" />
					Checkpoint PR and tear down
				</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

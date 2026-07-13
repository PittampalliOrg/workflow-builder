<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
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
		Loader2,
		SendHorizontal,
		XCircle
	} from '@lucide/svelte';
	import DevPreviewStatusCard from '$lib/components/dev/dev-preview-status-card.svelte';
	import DevServiceCard from '$lib/components/dev/dev-service-card.svelte';
	import CodeVersionsPanel from '$lib/components/dev/code-versions-panel.svelte';
	import type { DevEnvironmentSummary } from '$lib/components/dev/dev-environment-card.svelte';
	import StatusPill from '$lib/components/shared/status-pill.svelte';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';
	import SessionGoalBadge from '$lib/components/sessions/session-goal-badge.svelte';
	import {
		deriveDevExecutionLifecycle,
		type DevExecutionLifecycleState
	} from '$lib/dev/dev-execution-lifecycle';
	import { teardownDevEnvironmentUntilComplete } from '$lib/dev-environment-teardown';
	import { getDevEnvironment } from './data.remote';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');

	// SSR-seeded so there's no blank flash; the query hydrates and a single
	// visibility-gated 5s tick keeps it fresh (replacing the old 4s interval).
	const envQuery = $derived(getDevEnvironment(data.environment.executionId));
	const environment = $derived<DevEnvironmentSummary>(
		envQuery.current?.environment ?? data.environment
	);
	const services = $derived<DevEnvironmentSummary[]>(
		envQuery.current?.services ?? data.services ?? [data.environment]
	);

	let errorMessage = $state<string | null>(null);
	let confirmTeardown = $state(false);
	let busy = $state(false);
	// Code versions this run produced that haven't been pushed to a GitHub PR yet.
	let outstandingVersions = $state(0);

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

	function lifecycleIconClass(state: DevExecutionLifecycleState): string {
		if (state === 'complete') return 'text-emerald-600 dark:text-emerald-400';
		if (state === 'active') return 'text-amber-600 dark:text-amber-400';
		if (state === 'failed') return 'text-destructive';
		return 'text-muted-foreground/50';
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

	async function send() {
		const text = composer.trim();
		if (!text || !sessionId || sending) return;
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

	async function teardown() {
		confirmTeardown = false;
		busy = true;
		try {
			await teardownDevEnvironmentUntilComplete(environment.executionId);
			errorMessage = null;
			await goto(`/workspaces/${slug}/dev`);
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}
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
			<DevPreviewStatusCard {environment} {busy} onteardown={() => (confirmTeardown = true)} />
			<!-- B5: per-service card grid (health, sidecar status, run commands). -->
			<section class="space-y-2">
				<h2 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
					Services ({services.length})
				</h2>
				{#each services as svc (svc.service)}
					<DevServiceCard service={svc} />
				{/each}
			</section>
			<CodeVersionsPanel
				executionId={environment.executionId}
				live={!lifecycle.runTerminal}
				onoutstanding={(n) => (outstandingVersions = n)}
			/>
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
							placeholder="Message the coding agent…"
							bind:value={composer}
							onkeydown={onComposerKeydown}
							disabled={sending}
							aria-label="Message the coding agent"
						/>
						<Button
							onclick={send}
							disabled={sending || !composer.trim()}
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
			<AlertDialogTitle>Tear down {environment.service}?</AlertDialogTitle>
			<AlertDialogDescription>
				Deletes the preview pod and purges the interactive session. This can't be undone.
			</AlertDialogDescription>
		</AlertDialogHeader>
		{#if outstandingVersions > 0}
			<div
				class="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
			>
				<AlertTriangle class="mt-0.5 size-4 shrink-0" />
				<p>
					{outstandingVersions} code version{outstandingVersions === 1 ? '' : 's'} from this run
					{outstandingVersions === 1 ? 'has' : 'have'} not been pushed to a GitHub PR. They live only
					in this preview and will be lost on teardown — promote them first if you want to keep them.
				</p>
			</div>
		{/if}
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={teardown}>Tear down</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

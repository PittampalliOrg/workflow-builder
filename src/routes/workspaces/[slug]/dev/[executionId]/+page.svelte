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
	import { ArrowLeft, SendHorizontal } from '@lucide/svelte';
	import DevPreviewStatusCard from '$lib/components/dev/dev-preview-status-card.svelte';
	import DevServiceCard from '$lib/components/dev/dev-service-card.svelte';
	import CodeVersionsPanel from '$lib/components/dev/code-versions-panel.svelte';
	import type { DevEnvironmentSummary } from '$lib/components/dev/dev-environment-card.svelte';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';
	import SessionGoalBadge from '$lib/components/sessions/session-goal-badge.svelte';
	import { getDevEnvironment } from './data.remote';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const slug = $derived((page.params.slug as string) ?? 'default');

	// SSR-seeded so there's no blank flash; the query hydrates and a single
	// visibility-gated 5s tick keeps it fresh (replacing the old 4s interval).
	const envQuery = getDevEnvironment(data.environment.executionId);
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
			const res = await fetch(`/api/dev-environments/${environment.executionId}`, {
				method: 'DELETE'
			});
			if (!res.ok) {
				errorMessage = `Teardown failed (${res.status})`;
				return;
			}
			goto(`/workspaces/${slug}/dev`);
		} finally {
			busy = false;
		}
	}
</script>

<div class="h-full flex flex-col">
	<header class="flex items-center gap-3 border-b px-5 py-3">
		<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/dev`)}>
			<ArrowLeft class="size-4" /> Dev
		</Button>
		<h1 class="font-semibold truncate">{environment.service}</h1>
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

	<div class="flex-1 min-h-0 grid lg:grid-cols-[340px_1fr] gap-0">
		<!-- Status / controls column -->
		<aside class="border-r p-4 overflow-y-auto space-y-4">
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
				live={environment.runStatus !== 'completed' &&
					environment.runStatus !== 'failed' &&
					environment.runStatus !== 'terminated'}
				onoutstanding={(n) => (outstandingVersions = n)}
			/>
		</aside>

		<!-- Interactive session column -->
		<section class="flex flex-col min-h-0">
			{#if sessionId}
				<div class="flex-1 min-h-0 overflow-hidden">
					<SessionTranscript {sessionId} showPulse showTimeline class="h-full" />
				</div>
				<div class="border-t p-3">
					<div class="flex items-end gap-2">
						<Textarea
							class="min-h-[44px] max-h-40 resize-none"
							placeholder="Message the coding agent…  (⌘/Ctrl+Enter to send)"
							bind:value={composer}
							onkeydown={onComposerKeydown}
							disabled={sending}
						/>
						<Button onclick={send} disabled={sending || !composer.trim()}>
							<SendHorizontal class="size-4" />
						</Button>
					</div>
				</div>
			{:else}
				<div class="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-2">
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
				class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
			>
				⚠ {outstandingVersions} code version{outstandingVersions === 1 ? '' : 's'} from this run
				{outstandingVersions === 1 ? 'has' : 'have'} not been pushed to a GitHub PR. They live only in
				this preview and will be lost on teardown — promote them first if you want to keep them.
			</div>
		{/if}
		<AlertDialogFooter>
			<AlertDialogCancel>Cancel</AlertDialogCancel>
			<AlertDialogAction onclick={teardown}>Tear down</AlertDialogAction>
		</AlertDialogFooter>
	</AlertDialogContent>
</AlertDialog>

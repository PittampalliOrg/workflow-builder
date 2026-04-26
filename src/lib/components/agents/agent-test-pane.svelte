<script lang="ts">
	import { onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { DEFAULT_WORKSPACE_SLUG } from '$lib/utils/workspace-path';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { Textarea } from '$lib/components/ui/textarea';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import {
		ExternalLink,
		Loader2,
		Play,
		Square,
		Terminal,
		Wrench
	} from 'lucide-svelte';
	import {
		createSessionStream,
		type SessionStreamStore
	} from '$lib/stores/session-stream.svelte';
	import type { SessionEventEnvelope } from '$lib/types/sessions';

	interface Props {
		agentId: string;
	}

	let { agentId }: Props = $props();

	let prompt = $state('');
	let pending = $state(false);
	let status = $state<'idle' | 'running' | 'complete' | 'error'>('idle');
	let errorMessage = $state<string | null>(null);
	const slug = $derived(
		(page.params.slug as string | undefined) ?? DEFAULT_WORKSPACE_SLUG,
	);
	let sessionId = $state<string | null>(null);
	let stream = $state<SessionStreamStore | null>(null);
	let events = $state<SessionEventEnvelope[]>([]);
	let sessionStatus = $state<string | null>(null);
	let isConnected = $state(false);

	let unsub: (() => void) | null = null;

	onDestroy(() => {
		teardown();
	});

	function teardown() {
		if (unsub) {
			unsub();
			unsub = null;
		}
		stream?.dispose();
		stream = null;
	}

	async function run() {
		errorMessage = null;
		teardown();
		events = [];
		status = 'running';
		pending = true;
		try {
			const res = await fetch('/api/v1/sessions', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					agentId,
					title: `Test: ${prompt.slice(0, 40)}`,
					initialMessage: prompt
				})
			});
			if (!res.ok) {
				errorMessage = `Session start failed (${res.status}): ${await res.text()}`;
				status = 'error';
				return;
			}
			const { session } = (await res.json()) as {
				session: { id: string; daprInstanceId?: string | null; errorMessage?: string | null };
			};
			sessionId = session.id;
			if (!session.daprInstanceId && session.errorMessage) {
				errorMessage = `Session start failed: ${session.errorMessage}`;
				status = 'error';
				return;
			}
			stream = createSessionStream(session.id);
			unsub = stream.subscribe((state) => {
				events = state.events;
				isConnected = state.isConnected;
				sessionStatus = state.session?.status ?? null;
				if (state.session?.status === 'terminated') {
					status = 'complete';
				}
			});
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
			status = 'error';
		} finally {
			pending = false;
		}
	}

	async function stop() {
		if (sessionId) {
			try {
				await fetch(`/api/v1/sessions/${sessionId}/control/interrupt`, {
					method: 'POST'
				});
			} catch {
				/* ignore */
			}
		}
		teardown();
		status = 'idle';
		sessionId = null;
	}

	function formatEvent(event: SessionEventEnvelope): {
		kind: 'tool' | 'agent' | 'status' | 'user' | 'other';
		label: string;
		detail: string;
	} {
		const { type, data } = event;
		if (type === 'agent.message' || type === 'agent.thinking') {
			const content = (data as { content?: Array<{ text?: string }> }).content ?? [];
			const text = content.map((c) => c.text ?? '').join('');
			return { kind: 'agent', label: type === 'agent.thinking' ? 'thinking' : 'agent', detail: truncate(text) };
		}
		if (type === 'agent.tool_use' || type === 'agent.mcp_tool_use') {
			return {
				kind: 'tool',
				label: `→ ${String((data as { name?: unknown }).name ?? 'tool')}`,
				detail: truncate(JSON.stringify((data as { input?: unknown }).input ?? ''))
			};
		}
		if (type === 'agent.tool_result' || type === 'agent.mcp_tool_result') {
			return { kind: 'tool', label: '✓ tool result', detail: truncate(JSON.stringify(data)) };
		}
		if (type === 'user.message') {
			const content = (data as { content?: Array<{ text?: string }> }).content ?? [];
			return { kind: 'user', label: 'you', detail: truncate(content.map((c) => c.text ?? '').join('')) };
		}
		if (type.startsWith('session.status_')) {
			return { kind: 'status', label: type.replace('session.status_', ''), detail: '' };
		}
		return { kind: 'other', label: type, detail: truncate(JSON.stringify(data)) };
	}

	function truncate(v: string, max = 240): string {
		if (!v) return '';
		return v.length <= max ? v : v.slice(0, max) + '…';
	}

	function iconFor(kind: ReturnType<typeof formatEvent>['kind']) {
		if (kind === 'tool') return Wrench;
		if (kind === 'status') return Terminal;
		return null;
	}
</script>

<div class="space-y-3">
	<Textarea
		rows={4}
		placeholder="Quick prompt to test this agent…"
		bind:value={prompt}
		disabled={status === 'running'}
	/>
	<div class="flex items-center gap-2">
		{#if status === 'running'}
			<Button class="flex-1" variant="outline" onclick={stop}>
				<Square class="size-4" /> Stop
			</Button>
		{:else}
			<Button
				class="flex-1"
				size="sm"
				disabled={!prompt.trim() || pending}
				onclick={run}
			>
				{#if pending}
					<Loader2 class="size-4 animate-spin" /> Starting…
				{:else}
					<Play class="size-4" /> Run
				{/if}
			</Button>
		{/if}
	</div>

	{#if errorMessage}
		<div class="text-xs text-destructive p-2 rounded bg-destructive/10">{errorMessage}</div>
	{/if}

	{#if sessionId}
		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			<Badge variant={isConnected ? 'secondary' : 'outline'}>
				{isConnected ? 'streaming' : 'connecting…'}
			</Badge>
			{#if sessionStatus}
				<Badge variant="outline">{sessionStatus}</Badge>
			{/if}
			<a
				href="/workspaces/{slug}/sessions/{sessionId}"
				target="_blank"
				class="ml-auto hover:underline flex items-center gap-1"
			>
				Open full session <ExternalLink class="size-3" />
			</a>
		</div>
	{/if}

	{#if events.length > 0}
		<ScrollArea class="h-80 border rounded p-2 text-xs font-mono">
			<div class="space-y-1">
				{#each events as ev (ev.id)}
					{@const formatted = formatEvent(ev)}
					{@const Icon = iconFor(formatted.kind)}
					<div
						class="flex items-start gap-2 leading-relaxed {formatted.kind === 'status'
							? 'text-muted-foreground'
							: formatted.kind === 'user'
								? 'text-primary'
								: ''}"
					>
						{#if Icon}
							<Icon class="size-3 mt-0.5 shrink-0" />
						{:else}
							<span class="text-muted-foreground shrink-0 w-3 text-center">•</span>
						{/if}
						<div class="flex-1 min-w-0">
							<span class="font-semibold">{formatted.label}</span>
							{#if formatted.detail}
								<span class="text-muted-foreground ml-2 break-words">{formatted.detail}</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</ScrollArea>
	{:else if status === 'running'}
		<div class="text-xs text-muted-foreground flex items-center gap-2 py-4">
			<Loader2 class="size-3 animate-spin" /> Waiting for first event…
		</div>
	{/if}
</div>

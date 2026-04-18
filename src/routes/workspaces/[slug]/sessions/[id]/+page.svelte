<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount } from 'svelte';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		Card,
		CardContent,
		CardHeader,
		CardTitle
	} from '$lib/components/ui/card';
	import { ScrollArea } from '$lib/components/ui/scroll-area';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Switch } from '$lib/components/ui/switch';
	import { Label } from '$lib/components/ui/label';
	import {
		Popover,
		PopoverContent,
		PopoverTrigger
	} from '$lib/components/ui/popover';
	import ApiSnippet from '$lib/components/console/api-snippet.svelte';
	import CopyIdButton from '$lib/components/console/copy-id-button.svelte';
	import EventRow from '$lib/components/sessions/event-row.svelte';
	import EventDetailPanel from '$lib/components/sessions/event-detail-panel.svelte';
	import SessionTimelineBar from '$lib/components/sessions/session-timeline-bar.svelte';
	import EventTypePill from '$lib/components/sessions/event-type-pill.svelte';
	import StopReasonChip from '$lib/components/sessions/stop-reason-chip.svelte';
	import SessionResourcesPanel from '$lib/components/sessions/session-resources-panel.svelte';
	import SessionOutputsPanel from '$lib/components/sessions/session-outputs-panel.svelte';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch-plus';
	import {
		Reasoning,
		ReasoningTrigger,
		ReasoningContent
	} from '$lib/components/ui/ai-elements/reasoning';
	import {
		Archive,
		ArrowLeft,
		Bot,
		Activity,
		Check,
		Clock,
		Code2,
		Container,
		ExternalLink,
		Layers,
		Loader2,
		MessagesSquare,
		Save,
		Send,
		Settings,
		Square,
		Terminal,
		User,
		Workflow,
		Wrench,
		X
	} from 'lucide-svelte';
	import {
		createSessionStream,
		type SessionStreamStore
	} from '$lib/stores/session-stream.svelte';
	import type {
		SessionDetail,
		SessionEventEnvelope
	} from '$lib/types/sessions';

	const slug = $derived((page.params.slug as string) ?? 'default');

	const sessionId = page.params.id as string;

	let session = $state<SessionDetail | null>(null);
	let events = $state<SessionEventEnvelope[]>([]);
	// Transcript: user-facing messages + tool-use (compacted); hides thinking
	// and raw status events. Debug: show every event verbatim.
	let viewMode = $state<'transcript' | 'debug'>('transcript');
	const displayEvents = $derived.by(() => {
		if (viewMode === 'debug') return events;
		return events.filter((e) => {
			if (e.type === 'agent.thinking') return false;
			if (e.type.startsWith('session.status_') && e.type !== 'session.status_terminated')
				return false;
			return true;
		});
	});
	let isConnected = $state(false);
	let isConsolidating = $state(false);
	let streamError = $state<string | null>(null);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let input = $state('');
	let sending = $state(false);
	let editingTitle = $state(false);
	let titleDraft = $state('');
	// Per-tool denial state: toolUseId → {open: did user click Deny once, reason: textarea draft}
	let denyDrafts = $state<Record<string, { open: boolean; reason: string }>>({});
	// Wave 4.18: amber banner for vault credentials expiring within 24h
	let expiringCreds = $state<
		Array<{ vaultId: string; credId: string; displayName: string; expiresAt: string }>
	>([]);
	// Liveness of the per-session OpenShell sandbox. Sessions persist the
	// sandbox name forever, but OpenShell GCs the sandbox after the session
	// terminates — so links to /sandboxes/<name> often 404. We probe on load
	// and re-probe on status change to mark the card as "terminated" instead
	// of inviting the user to click a dead link.
	let sandboxAlive = $state<'unknown' | 'alive' | 'terminated'>('unknown');
	// CMA-style compact event list: a single selected event is expanded in
	// the right-side detail panel. When null, we auto-select the newest
	// event so the panel is never empty once events start flowing.
	let selectedEventId = $state<string | null>(null);
	const sessionStartMs = $derived.by(() => {
		if (!session?.createdAt) return null;
		return new Date(session.createdAt).getTime();
	});
	const selectedEvent = $derived.by(() => {
		const list = displayEvents;
		if (list.length === 0) return null;
		const explicit = list.find((e) => String(e.id) === selectedEventId);
		return explicit ?? list[list.length - 1];
	});
	// Auto-follow newest while streaming: if the user hasn't pinned a
	// selection, roll the selected pointer forward as new events arrive.
	$effect(() => {
		if (selectedEventId !== null) return;
		const last = displayEvents[displayEvents.length - 1];
		if (last) {
			// no-op: selectedEvent derived handles the default. This effect only
			// exists to keep the reactive chain attached to displayEvents.
			void last.id;
		}
	});

	let stream = $state<SessionStreamStore | null>(null);
	let unsub: (() => void) | null = null;
	let scrollEl: HTMLDivElement | undefined = $state();

	async function initialLoad() {
		loading = true;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}`);
			if (!res.ok) {
				errorMessage = `Failed to load session (${res.status})`;
				return;
			}
			const data = (await res.json()) as { session: SessionDetail };
			session = data.session;
			titleDraft = session.title ?? '';
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	async function checkSandboxLiveness() {
		if (!session) {
			sandboxAlive = 'unknown';
			return;
		}
		const name = session.workspaceSandboxName ?? session.sandboxName;
		if (!name) {
			sandboxAlive = 'unknown';
			return;
		}
		try {
			const res = await fetch(`/api/sandboxes/${encodeURIComponent(name)}`);
			sandboxAlive = res.ok ? 'alive' : 'terminated';
		} catch {
			sandboxAlive = 'unknown';
		}
	}

	async function checkExpiringCreds() {
		if (!session || session.vaultIds.length === 0) {
			expiringCreds = [];
			return;
		}
		const threshold = Date.now() + 24 * 3_600_000;
		try {
			const results = await Promise.all(
				session.vaultIds.map((vid) =>
					fetch(`/api/v1/vaults/${vid}/credentials`)
						.then((r) => (r.ok ? r.json() : { credentials: [] }))
						.catch(() => ({ credentials: [] }))
				)
			);
			const out: typeof expiringCreds = [];
			for (let i = 0; i < results.length; i++) {
				const vid = session.vaultIds[i];
				const creds = (results[i]?.credentials ?? []) as Array<{
					id: string;
					displayName: string;
					expiresAt: string | null;
				}>;
				for (const c of creds) {
					if (!c.expiresAt) continue;
					const t = new Date(c.expiresAt).getTime();
					if (t > 0 && t < threshold) {
						out.push({
							vaultId: vid,
							credId: c.id,
							displayName: c.displayName,
							expiresAt: c.expiresAt
						});
					}
				}
			}
			expiringCreds = out;
		} catch {
			// non-fatal
		}
	}

	onMount(() => {
		void (async () => {
			await initialLoad();
			void checkExpiringCreds();
			void checkSandboxLiveness();
		})();
		stream = createSessionStream(sessionId);
		unsub = stream.subscribe((state) => {
			isConnected = state.isConnected;
			isConsolidating = state.isConsolidating;
			streamError = state.error;
			events = state.events;
			if (state.session) session = state.session;
			queueScroll();
		});
	});

	// Re-probe sandbox liveness whenever session transitions to terminated.
	let lastKnownStatus = $state<string | null>(null);
	$effect(() => {
		const status = session?.status ?? null;
		if (status !== lastKnownStatus) {
			lastKnownStatus = status;
			if (status === 'terminated' || status === 'idle') {
				void checkSandboxLiveness();
			}
		}
	});

	onDestroy(() => {
		if (unsub) unsub();
		stream?.dispose();
	});

	function queueScroll() {
		queueMicrotask(() => {
			if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
		});
	}

	async function send() {
		if (!input.trim() || sending) return;
		const text = input;
		input = '';
		sending = true;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/events`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					events: [
						{
							type: 'user.message',
							content: [{ type: 'text', text }]
						}
					]
				})
			});
			if (!res.ok) {
				errorMessage = `Send failed (${res.status}): ${await res.text()}`;
				input = text;
			}
		} finally {
			sending = false;
		}
	}

	async function interrupt() {
		await fetch(`/api/v1/sessions/${sessionId}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ events: [{ type: 'user.interrupt' }] })
		});
	}

	async function confirmTool(toolUseId: string, allow: boolean, denyMessage?: string) {
		await fetch(`/api/v1/sessions/${sessionId}/events`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				events: [
					{
						type: 'user.tool_confirmation',
						tool_use_id: toolUseId,
						result: allow ? 'allow' : 'deny',
						...(denyMessage ? { deny_message: denyMessage } : {})
					}
				]
			})
		});
	}

	let forking = $state(false);

	async function forkFromEvent(sequence: number) {
		if (forking) return;
		forking = true;
		try {
			const res = await fetch(`/api/v1/sessions/${sessionId}/fork`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ fromSequence: sequence })
			});
			if (!res.ok) {
				console.error('[fork] failed', await res.text());
				return;
			}
			const body = (await res.json()) as { sessionId: string };
			if (body.sessionId) goto(`/workspaces/${slug}/sessions/${body.sessionId}`);
		} finally {
			forking = false;
		}
	}

	async function saveTitle() {
		if (!session) return;
		const res = await fetch(`/api/v1/sessions/${sessionId}`, {
			method: 'PUT',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: titleDraft })
		});
		if (res.ok) {
			const data = (await res.json()) as { session: SessionDetail };
			session = data.session;
			editingTitle = false;
		}
	}

	async function archive() {
		if (!session) return;
		const res = await fetch(`/api/v1/sessions/${sessionId}`, { method: 'PATCH' });
		if (res.ok) goto(`/workspaces/${slug}/sessions`);
	}

	async function setModel(modelSpec: string) {
		const res = await fetch(`/api/v1/sessions/${sessionId}/control/set-model`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ modelSpec })
		});
		if (!res.ok) {
			errorMessage = `Set-model failed (${res.status})`;
		}
	}

	async function setPermissionMode(mode: 'bypass' | 'default') {
		const res = await fetch(`/api/v1/sessions/${sessionId}/control/set-permission-mode`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ mode })
		});
		if (!res.ok) {
			errorMessage = `Set-permission-mode failed (${res.status})`;
		}
	}

	let bypassEnabled = $state(false);
	const MODEL_OPTIONS = [
		'claude-opus-4-7',
		'claude-opus-4-6',
		'claude-sonnet-4-6',
		'claude-haiku-4-5'
	];

	function formatEvent(event: SessionEventEnvelope) {
		const { type, data } = event;
		switch (type) {
			case 'user.message': {
				const content = (data as { content?: Array<{ text?: string }> }).content ?? [];
				return {
					kind: 'user' as const,
					text: content.map((c) => c.text ?? '').join('')
				};
			}
			case 'agent.message': {
				const content = (data as { content?: Array<{ text?: string }> }).content ?? [];
				return {
					kind: 'agent' as const,
					text: content.map((c) => c.text ?? '').join('')
				};
			}
			case 'agent.thinking': {
				// CMA shape: data.content = [{type:"text", text:"..."}]
				const content = (data as { content?: Array<{ text?: string }> }).content ?? [];
				const text = content.map((c) => c.text ?? '').join('').trim();
				return { kind: 'thinking' as const, text };
			}
			case 'agent.tool_use':
			case 'agent.mcp_tool_use':
				return {
					kind: 'tool_use' as const,
					name: String(
						(data as { name?: unknown }).name ?? (data as { tool_name?: unknown }).tool_name ?? ''
					),
					input: (data as { input?: unknown }).input,
					needsApproval:
						(data as { evaluated_permission?: string }).evaluated_permission === 'ask',
					toolUseId: event.id
				};
			case 'agent.tool_result':
			case 'agent.mcp_tool_result':
				return { kind: 'tool_result' as const, data };
			case 'agent.custom_tool_use':
				return {
					kind: 'custom_tool_use' as const,
					name: String((data as { name?: unknown }).name ?? ''),
					input: (data as { input?: unknown }).input,
					toolUseId: event.id
				};
			case 'session.status_idle': {
				const sr = (data as { stop_reason?: { type?: string } }).stop_reason;
				const friendly =
					sr?.type === 'end_turn'
						? 'finished the turn'
						: sr?.type === 'requires_action'
							? 'needs your input'
							: sr?.type === 'retries_exhausted'
								? 'retries exhausted'
								: 'idle';
				return {
					kind: 'status' as const,
					text: `Agent ${friendly}`
				};
			}
			case 'session.status_running':
				return { kind: 'status' as const, text: 'Running…' };
			case 'session.status_rescheduled':
				return { kind: 'status' as const, text: 'Rescheduled' };
			case 'span.model_request_start':
			case 'span.model_request_end':
				return { kind: 'span' as const };
			default:
				return {
					kind: 'other' as const,
					type
				};
		}
	}
</script>

<div class="flex flex-col h-screen">
	<div class="border-b bg-muted/30 px-4 py-2 flex items-center gap-1 text-xs text-muted-foreground">
		<a href="/workspaces/{slug}/sessions" class="hover:text-foreground">Sessions</a>
		<span class="text-muted-foreground/60">/</span>
		{#if session}
			<CopyIdButton value={session.id} />
		{:else}
			<span>Loading…</span>
		{/if}
	</div>
	<header class="border-b p-3 flex items-center gap-3 flex-wrap">
		<Button variant="ghost" size="sm" onclick={() => goto(`/workspaces/${slug}/sessions`)}>
			<ArrowLeft class="size-4" />
		</Button>
		<div class="flex items-center gap-2 flex-1 min-w-0">
			<div class="size-8 rounded bg-primary/10 flex items-center justify-center">
				<MessagesSquare class="size-4 text-primary" />
			</div>
			<div class="flex-1 min-w-0">
				{#if editingTitle}
					<div class="flex items-center gap-2">
						<Input bind:value={titleDraft} placeholder="Session title" />
						<Button size="sm" onclick={saveTitle}>
							<Save class="size-3" /> Save
						</Button>
						<Button size="sm" variant="ghost" onclick={() => (editingTitle = false)}>
							<X class="size-3" />
						</Button>
					</div>
				{:else}
					<button
						type="button"
						class="text-left w-full"
						onclick={() => {
							editingTitle = true;
							titleDraft = session?.title ?? '';
						}}
					>
						<div class="font-semibold text-base truncate">
							{session?.title ?? 'Untitled session'}
						</div>
						<div class="text-xs text-muted-foreground">
							{session?.agentId ?? '…'} · v{session?.agentVersion ?? '—'} ·
							<span class="capitalize">{session?.status ?? 'loading'}</span>
						</div>
					</button>
				{/if}
			</div>
		</div>
		<Badge variant={isConnected ? 'secondary' : 'outline'} class="text-[10px]">
			{isConsolidating ? 'catching up…' : isConnected ? 'streaming' : 'connecting…'}
		</Badge>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button variant="outline" size="sm" {...props} title="Session controls">
						<Settings class="size-4" /> Controls
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-64">
				<DropdownMenu.Label class="text-[10px] uppercase tracking-wide text-muted-foreground">
					Model
				</DropdownMenu.Label>
				{#each MODEL_OPTIONS as m (m)}
					<DropdownMenu.Item onSelect={() => setModel(m)} class="font-mono text-xs">
						{m}
					</DropdownMenu.Item>
				{/each}
				<DropdownMenu.Separator />
				<div class="px-2 py-1.5 flex items-center justify-between">
					<Label for="bypass-toggle" class="text-xs">Bypass permissions</Label>
					<Switch
						id="bypass-toggle"
						checked={bypassEnabled}
						onCheckedChange={(v) => {
							bypassEnabled = v;
							setPermissionMode(v ? 'bypass' : 'default');
						}}
					/>
				</div>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
		<Popover>
			<PopoverTrigger>
				<Button variant="outline" size="sm" title="Show API snippet">
					<Code2 class="size-4" /> Code
				</Button>
			</PopoverTrigger>
			<PopoverContent class="w-[560px] p-3" align="end">
				<div class="text-xs font-semibold mb-1">Post messages via the API</div>
				<p class="text-xs text-muted-foreground mb-2">
					Append a user message and stream response events via SSE.
				</p>
				<ApiSnippet
					curl={`curl -X POST $WORKFLOW_BUILDER_URL/api/v1/sessions/${sessionId}/events \\\n  -H 'Authorization: Bearer $WB_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"type":"user.message","data":{"content":[{"type":"text","text":"Hello"}]}}'`}
					python={`import requests\n\nrequests.post(\n    f"{WORKFLOW_BUILDER_URL}/api/v1/sessions/${sessionId}/events",\n    headers={"Authorization": f"Bearer {WB_API_KEY}"},\n    json={\n        "type": "user.message",\n        "data": {"content": [{"type": "text", "text": "Hello"}]},\n    },\n)\n\n# Stream events (SSE)\nwith requests.get(\n    f"{WORKFLOW_BUILDER_URL}/api/v1/sessions/${sessionId}/events/stream",\n    headers={"Authorization": f"Bearer {WB_API_KEY}"},\n    stream=True,\n) as s:\n    for line in s.iter_lines():\n        print(line)`}
					typescript={`await fetch(\n  \`\${WORKFLOW_BUILDER_URL}/api/v1/sessions/${sessionId}/events\`,\n  {\n    method: 'POST',\n    headers: {\n      Authorization: \`Bearer \${WB_API_KEY}\`,\n      'Content-Type': 'application/json'\n    },\n    body: JSON.stringify({\n      type: 'user.message',\n      data: { content: [{ type: 'text', text: 'Hello' }] }\n    })\n  }\n);\n\n// Stream events via EventSource\nconst es = new EventSource(\n  \`\${WORKFLOW_BUILDER_URL}/api/v1/sessions/${sessionId}/events/stream\`\n);\nes.onmessage = (e) => console.log(JSON.parse(e.data));`}
				/>
			</PopoverContent>
		</Popover>
		<Button variant="outline" size="sm" onclick={archive}>
			<Archive class="size-4" /> Archive
		</Button>
	</header>

	{#if errorMessage || streamError}
		<Alert variant="destructive" class="m-3">
			<AlertDescription>{errorMessage ?? streamError}</AlertDescription>
		</Alert>
	{/if}

	{#if expiringCreds.length > 0}
		<Alert
			class="mx-3 mt-3 border-amber-500/50 bg-amber-500/5 text-amber-900 dark:text-amber-200"
		>
			<AlertDescription class="flex items-center flex-wrap gap-x-2 gap-y-1">
				<Clock class="size-4 inline" />
				{expiringCreds.length} credential{expiringCreds.length === 1 ? '' : 's'}
				expire{expiringCreds.length === 1 ? 's' : ''} within 24h:
				{#each expiringCreds as c, i (c.credId)}
					<a href="/workspaces/{slug}/vaults/{c.vaultId}" class="underline">{c.displayName}</a
					>{#if i < expiringCreds.length - 1},&nbsp;{/if}
				{/each}
				<span class="text-[11px] opacity-70 ml-auto">
					Rotate now on the vault page to refresh the OAuth tokens.
				</span>
			</AlertDescription>
		</Alert>
	{/if}

	<div class="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] overflow-hidden">
		<div class="flex flex-col overflow-hidden">
			<div class="border-b px-4 py-2 flex items-center gap-2">
				<div class="inline-flex rounded-md border bg-muted/30 p-0.5">
					<button
						type="button"
						class="px-3 py-1 text-xs rounded {viewMode === 'transcript' ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
						onclick={() => (viewMode = 'transcript')}
					>
						Transcript
					</button>
					<button
						type="button"
						class="px-3 py-1 text-xs rounded {viewMode === 'debug' ? 'bg-background shadow-sm' : 'text-muted-foreground'}"
						onclick={() => (viewMode = 'debug')}
					>
						Debug
					</button>
				</div>
				<span class="text-[10px] text-muted-foreground">
					{#if viewMode === 'transcript'}
						{displayEvents.length} message{displayEvents.length === 1 ? '' : 's'} · thinking + status events hidden
					{:else}
						{events.length} raw event{events.length === 1 ? '' : 's'}
					{/if}
				</span>
			</div>
			<!-- CMA-shape timeline bar: one colored segment per event, width
			     proportional to duration. Click a segment to select. -->
			{#if displayEvents.length > 0}
				<div class="border-b px-4 py-2">
					<SessionTimelineBar
						events={displayEvents}
						selectedId={selectedEvent ? String(selectedEvent.id) : null}
						onSelect={(id) => (selectedEventId = id)}
					/>
				</div>
			{/if}

			<div class="flex-1 grid grid-cols-1 lg:grid-cols-[minmax(260px,380px)_1fr] overflow-hidden">
				<!-- Left: compact event list -->
				<div bind:this={scrollEl} class="overflow-y-auto border-r py-1">
					{#if loading}
						<div class="p-3 space-y-1.5">
							<Skeleton class="h-6" />
							<Skeleton class="h-6" />
							<Skeleton class="h-6" />
						</div>
					{:else if displayEvents.length === 0}
						<div class="text-center text-muted-foreground text-sm py-16 px-4">
							{session?.status === 'terminated'
								? 'Session ended with no events.'
								: 'Waiting for the agent to start…'}
						</div>
					{:else}
						<div class="space-y-0.5 px-1.5">
							{#each displayEvents as ev (ev.id)}
								{@const elapsed =
									sessionStartMs !== null
										? new Date(ev.createdAt).getTime() - sessionStartMs
										: undefined}
								<EventRow
									event={ev}
									selected={selectedEvent ? String(selectedEvent.id) === String(ev.id) : false}
									elapsedMs={elapsed}
									onClick={() => (selectedEventId = String(ev.id))}
								/>
							{/each}
						</div>
					{/if}
				</div>

				<!-- Right: expanded detail panel -->
				<div class="overflow-hidden">
					{#if selectedEvent}
						{@const elapsed =
							sessionStartMs !== null
								? new Date(selectedEvent.createdAt).getTime() - sessionStartMs
								: undefined}
						<EventDetailPanel
							event={selectedEvent}
							elapsedMs={elapsed}
							debug={viewMode === 'debug'}
							onClose={() => (selectedEventId = null)}
						/>
					{:else if !loading}
						<div class="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
							Select an event on the left to see its content.
						</div>
					{/if}
				</div>
			</div>

			<div class="border-t p-3 space-y-2">
				<div class="flex gap-2">
					<Textarea
						rows={2}
						placeholder="Send a message…"
						bind:value={input}
						disabled={sending || session?.status === 'terminated'}
						onkeydown={(e) => {
							if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
								e.preventDefault();
								send();
							}
						}}
					/>
					<div class="flex flex-col gap-2">
						{#if session?.status === 'running'}
							<Button variant="outline" size="icon" onclick={interrupt} title="Interrupt">
								<Square class="size-4" />
							</Button>
						{/if}
						<Button
							size="icon"
							disabled={!input.trim() || sending || session?.status === 'terminated'}
							onclick={send}
						>
							<Send class="size-4" />
						</Button>
					</div>
				</div>
				<p class="text-[10px] text-muted-foreground">
					⌘+Enter to send · Interrupt halts the current turn at the next safe boundary.
				</p>
			</div>
		</div>

		<aside class="border-l overflow-y-auto p-4 space-y-4 bg-muted/30">
			{#if session}
				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm flex items-center gap-2">
							<Bot class="size-4" /> Agent
						</CardTitle>
					</CardHeader>
					<CardContent class="text-xs space-y-1">
						<div>
							<a href="/workspaces/{slug}/agents/{session.agentId}" class="text-primary hover:underline">
								{session.agentId}
							</a>
						</div>
						<div class="text-muted-foreground">v{session.agentVersion ?? '—'}</div>
					</CardContent>
				</Card>

				{#if session.environmentId}
					<Card>
						<CardHeader class="pb-2">
							<CardTitle class="text-sm flex items-center gap-2">
								<Layers class="size-4" /> Environment
							</CardTitle>
						</CardHeader>
						<CardContent class="text-xs space-y-1">
							<a
								href="/workspaces/{slug}/environments/{session.environmentId}"
								class="text-primary hover:underline"
							>
								{session.environmentId}
							</a>
							<div class="text-muted-foreground">v{session.environmentVersion ?? '—'}</div>
						</CardContent>
					</Card>
				{/if}

				{#if session.vaultIds.length > 0}
					<Card>
						<CardHeader class="pb-2">
							<CardTitle class="text-sm">Vaults</CardTitle>
						</CardHeader>
						<CardContent class="text-xs space-y-1">
							{#each session.vaultIds as vid}
								<a href="/workspaces/{slug}/vaults/{vid}" class="text-primary hover:underline block truncate">
									{vid}
								</a>
							{/each}
						</CardContent>
					</Card>
				{/if}

				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm flex items-center gap-2">
							<Activity class="size-4" /> Observability
						</CardTitle>
					</CardHeader>
					<CardContent class="text-xs space-y-1.5">
						<a
							href="/api/observability/phoenix/sessions/{session.id}"
							target="_blank"
							rel="noreferrer"
							class="text-primary hover:underline flex items-center gap-1"
						>
							Open in Phoenix <ExternalLink class="size-3" />
						</a>
						<a
							href="/observability?sessionId={session.id}"
							class="text-primary hover:underline block"
						>
							Trace explorer ↗
						</a>
						<div class="text-[10px] text-muted-foreground pt-1">
							Spans emitted by the durable agent runtime — LLM calls, tool calls,
							compaction events.
						</div>
					</CardContent>
				</Card>

				{#if session.workflowExecutionId}
					<Card>
						<CardHeader class="pb-2">
							<CardTitle class="text-sm flex items-center gap-2">
								<Workflow class="size-4" /> Workflow run
							</CardTitle>
						</CardHeader>
						<CardContent class="text-xs space-y-1">
							<a
								href="/workflow-ops/executions?executionId={session.workflowExecutionId}"
								class="text-primary hover:underline truncate block"
							>
								{session.workflowExecutionId}
							</a>
							<div class="text-muted-foreground text-[10px]">
								This session was spawned by a <code>durable/run</code> node in
								a workflow. Click through to see the full DAG.
							</div>
						</CardContent>
					</Card>
				{/if}

				{#if session.workspaceSandboxName || session.sandboxName}
					{@const sbxName = session.workspaceSandboxName ?? session.sandboxName}
					<Card>
						<CardHeader class="pb-2">
							<CardTitle class="text-sm flex items-center gap-2">
								<Container class="size-4" />
								{session.workspaceSandboxName ? 'Session sandbox' : 'Sandbox runtime'}
								{#if sandboxAlive === 'alive'}
									<Badge
										variant="outline"
										class="text-[9px] gap-1 bg-green-600/15 text-green-700 dark:text-green-400 border-transparent"
									>
										<span class="size-1.5 rounded-full bg-green-500"></span>
										live
									</Badge>
								{:else if sandboxAlive === 'terminated'}
									<Badge variant="outline" class="text-[9px]">terminated</Badge>
								{/if}
							</CardTitle>
						</CardHeader>
						<CardContent class="text-xs space-y-1">
							{#if sandboxAlive === 'terminated'}
								<span class="font-mono text-muted-foreground line-through">{sbxName}</span>
								<div class="text-muted-foreground text-[10px]">
									The sandbox has been garbage-collected. Live terminal, files, and logs
									are no longer available for this session.
								</div>
							{:else if session.workspaceSandboxName}
								<a
									href="/sandboxes/{session.workspaceSandboxName}"
									class="text-primary hover:underline font-mono"
								>
									{session.workspaceSandboxName}
								</a>
								<div class="text-muted-foreground text-[10px]">
									Per-session OpenShell sandbox — open the terminal, browse files,
									and inspect live logs.
								</div>
							{:else if session.sandboxName}
								<a
									href="/sandboxes/{session.sandboxName}"
									class="text-primary hover:underline font-mono"
								>
									{session.sandboxName}
								</a>
								<div class="text-muted-foreground text-[10px]">
									Runtime pod — this session ran on the shared {session.sandboxName} agent deployment.
								</div>
							{/if}
						</CardContent>
					</Card>
				{/if}

				<SessionResourcesPanel {sessionId} />
				<SessionOutputsPanel {sessionId} />

				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm">Usage</CardTitle>
					</CardHeader>
					<CardContent class="text-xs text-muted-foreground space-y-0.5">
						<div>Input: {session.usage?.input_tokens ?? 0}</div>
						<div>Output: {session.usage?.output_tokens ?? 0}</div>
						<div>Cache read: {session.usage?.cache_read_input_tokens ?? 0}</div>
						<div>Cache creation: {session.usage?.cache_creation_input_tokens ?? 0}</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader class="pb-2">
						<CardTitle class="text-sm">Status</CardTitle>
					</CardHeader>
					<CardContent class="text-xs space-y-1.5">
						<div class="font-mono">{session.status}</div>
						{#if session.stopReason}
							<StopReasonChip stopReason={session.stopReason} />
						{/if}
						<div class="text-muted-foreground">
							<Clock class="inline size-3" />
							{new Date(session.updatedAt).toLocaleString()}
						</div>
					</CardContent>
				</Card>
			{/if}
		</aside>
	</div>
</div>

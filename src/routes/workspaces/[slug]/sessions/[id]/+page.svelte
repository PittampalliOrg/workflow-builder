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
	import {
		Archive,
		ArrowLeft,
		Bot,
		Check,
		Clock,
		Code2,
		Layers,
		Loader2,
		MessagesSquare,
		Save,
		Send,
		Settings,
		Square,
		Terminal,
		User,
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

	const sessionId = page.params.id as string;

	let session = $state<SessionDetail | null>(null);
	let events = $state<SessionEventEnvelope[]>([]);
	let isConnected = $state(false);
	let streamError = $state<string | null>(null);
	let loading = $state(true);
	let errorMessage = $state<string | null>(null);
	let input = $state('');
	let sending = $state(false);
	let editingTitle = $state(false);
	let titleDraft = $state('');

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

	onMount(() => {
		void initialLoad();
		stream = createSessionStream(sessionId);
		unsub = stream.subscribe((state) => {
			isConnected = state.isConnected;
			streamError = state.error;
			events = state.events;
			if (state.session) session = state.session;
			queueScroll();
		});
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
		if (res.ok) goto('/workspaces/default/sessions');
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
			case 'agent.thinking':
				return { kind: 'thinking' as const };
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
			case 'session.status_idle':
				return {
					kind: 'status' as const,
					text: `Idle — ${JSON.stringify((data as { stop_reason?: unknown }).stop_reason ?? {})}`
				};
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
	<header class="border-b p-3 flex items-center gap-3 flex-wrap">
		<Button variant="ghost" size="sm" onclick={() => goto('/workspaces/default/sessions')}>
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
			{isConnected ? 'streaming' : 'connecting…'}
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

	<div class="flex-1 grid grid-cols-1 lg:grid-cols-[1fr_320px] overflow-hidden">
		<div class="flex flex-col overflow-hidden">
			<div bind:this={scrollEl} class="flex-1 overflow-y-auto p-6 space-y-4">
				{#if loading}
					<Skeleton class="h-16" />
					<Skeleton class="h-16" />
				{:else if events.length === 0}
					<div class="text-center text-muted-foreground text-sm py-16">
						{session?.status === 'terminated'
							? 'Session ended with no events.'
							: 'Waiting for the agent to start…'}
					</div>
				{:else}
					{#each events as ev (ev.id)}
						{@const formatted = formatEvent(ev)}
						{#if formatted.kind === 'user'}
							<div class="flex justify-end">
								<div class="max-w-[80%] rounded-lg bg-primary text-primary-foreground p-3 text-sm">
									<div class="flex items-center gap-1 mb-1 opacity-70 text-[10px]">
										<User class="size-3" /> you
									</div>
									<div class="whitespace-pre-wrap">{formatted.text}</div>
								</div>
							</div>
						{:else if formatted.kind === 'agent'}
							<div class="flex justify-start">
								<div class="max-w-[80%] rounded-lg bg-muted p-3 text-sm">
									<div class="flex items-center gap-1 mb-1 opacity-70 text-[10px]">
										<Bot class="size-3" /> agent
									</div>
									<div class="whitespace-pre-wrap">{formatted.text}</div>
								</div>
							</div>
						{:else if formatted.kind === 'thinking'}
							<div class="flex items-center gap-2 text-xs text-muted-foreground pl-3">
								<Loader2 class="size-3 animate-spin" /> thinking…
							</div>
						{:else if formatted.kind === 'tool_use'}
							<div class="rounded border p-3 bg-muted/30">
								<div class="flex items-center gap-2 text-xs font-mono">
									<Wrench class="size-3" />
									<span class="font-semibold">{formatted.name}</span>
									{#if formatted.needsApproval}
										<Badge variant="outline" class="text-[10px] text-amber-600">
											awaits approval
										</Badge>
									{/if}
								</div>
								<pre class="mt-2 text-[10px] text-muted-foreground overflow-x-auto">{JSON.stringify(formatted.input, null, 2)}</pre>
								{#if formatted.needsApproval}
									<div class="mt-2 flex gap-2">
										<Button
											size="sm"
											onclick={() => confirmTool(formatted.toolUseId, true)}
										>
											<Check class="size-3" /> Allow
										</Button>
										<Button
											size="sm"
											variant="destructive"
											onclick={() => confirmTool(formatted.toolUseId, false)}
										>
											<X class="size-3" /> Deny
										</Button>
									</div>
								{/if}
							</div>
						{:else if formatted.kind === 'tool_result'}
							<div class="rounded border bg-background p-2 text-[10px] font-mono">
								<div class="flex items-center gap-1 text-muted-foreground">
									<Terminal class="size-3" /> result
								</div>
								<pre class="mt-1 overflow-x-auto">{JSON.stringify(formatted.data, null, 2).slice(0, 500)}</pre>
							</div>
						{:else if formatted.kind === 'custom_tool_use'}
							<div class="rounded border border-amber-500/50 bg-amber-500/5 p-3">
								<div class="flex items-center gap-2 text-xs font-mono">
									<Wrench class="size-3 text-amber-600" />
									<span class="font-semibold">{formatted.name}</span>
									<Badge variant="outline" class="text-[10px]">custom</Badge>
								</div>
								<pre class="mt-2 text-[10px] text-muted-foreground overflow-x-auto">{JSON.stringify(formatted.input, null, 2)}</pre>
								<p class="mt-2 text-[11px] text-muted-foreground">
									Waiting for orchestrator to post <code>user.custom_tool_result</code>.
								</p>
							</div>
						{:else if formatted.kind === 'status'}
							<div class="text-[11px] text-muted-foreground text-center py-1">
								{formatted.text}
							</div>
						{:else if formatted.kind === 'other'}
							<div class="text-[10px] text-muted-foreground">
								<code>{formatted.type}</code>
							</div>
						{/if}
					{/each}
				{/if}
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
							<a href="/workspaces/default/agents/{session.agentId}" class="text-primary hover:underline">
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
								href="/workspaces/default/environments/{session.environmentId}"
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
								<a href="/workspaces/default/vaults/{vid}" class="text-primary hover:underline block truncate">
									{vid}
								</a>
							{/each}
						</CardContent>
					</Card>
				{/if}

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
					<CardContent class="text-xs space-y-1">
						<div class="font-mono">{session.status}</div>
						{#if session.stopReason}
							<div class="text-muted-foreground">
								stop: <code>{JSON.stringify(session.stopReason)}</code>
							</div>
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

<script lang="ts">
	/**
	 * Canvas AI authoring for dynamic-script workflows.
	 *
	 * Binds a real GLM-5.2 interactive session (dapr-agent-py + the
	 * workflow-authoring MCP tools) to the open workflow. The user describes the
	 * workflow in natural language; the agent authors + validates + saves it via
	 * save_workflow_script (updating THIS row), and the ScriptCanvas re-renders.
	 * We embed SessionTranscript (self-contained SSE stream) + a composer.
	 */
	import { getContext } from 'svelte';
	import { Sparkles, Send, RotateCcw, Loader2, ExternalLink } from '@lucide/svelte';
	import { page } from '$app/state';
	import type { createWorkflowStore } from '$lib/stores/workflow.svelte';
	import SessionTranscript from '$lib/components/sessions/session-transcript.svelte';

	const store = getContext<ReturnType<typeof createWorkflowStore>>('workflow');
	const slug = $derived(page.params.slug as string);
	const workflowId = $derived(store.workflowId);

	let sessionId = $state<string | null>(null);
	let starting = $state(false);
	let sending = $state(false);
	let errorMessage = $state<string | null>(null);
	let input = $state('');

	const storageKey = $derived(workflowId ? `wb-author-session:${workflowId}` : null);

	// Restore a prior author session for this workflow (so switching tabs keeps
	// the conversation). Verify it still exists before adopting it.
	$effect(() => {
		if (!storageKey || typeof localStorage === 'undefined') return;
		const saved = localStorage.getItem(storageKey);
		if (saved && !sessionId) void adopt(saved);
	});

	async function adopt(id: string) {
		try {
			const res = await fetch(`/api/v1/sessions/${id}`);
			if (res.ok) sessionId = id;
			else if (storageKey) localStorage.removeItem(storageKey);
		} catch {
			/* offline — leave unbound */
		}
	}

	async function startSession() {
		if (!workflowId || starting) return;
		starting = true;
		errorMessage = null;
		try {
			const res = await fetch(`/api/workflows/${workflowId}/author-session`, {
				method: 'POST'
			});
			const body = (await res.json().catch(() => ({}))) as {
				sessionId?: string;
				message?: string;
			};
			if (!res.ok || !body.sessionId) {
				errorMessage = body.message || `Could not start authoring session (${res.status})`;
				return;
			}
			sessionId = body.sessionId;
			if (storageKey) localStorage.setItem(storageKey, body.sessionId);
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Failed to start authoring session';
		} finally {
			starting = false;
		}
	}

	function resetSession() {
		if (storageKey) localStorage.removeItem(storageKey);
		sessionId = null;
		errorMessage = null;
	}

	async function send() {
		const text = input.trim();
		if (!text || !sessionId || sending) return;
		input = '';
		sending = true;
		errorMessage = null;
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
				input = text;
			}
		} catch {
			errorMessage = 'Send failed';
			input = text;
		} finally {
			sending = false;
		}
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden">
	{#if !sessionId}
		<div class="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
			<div class="flex size-11 items-center justify-center rounded-xl border border-fuchsia-400/30 bg-fuchsia-500/10">
				<Sparkles class="size-5 text-fuchsia-300" />
			</div>
			<div class="max-w-xs space-y-1">
				<h3 class="text-sm font-semibold">Author with AI</h3>
				<p class="text-xs text-muted-foreground">
					Describe the workflow in plain language. A GLM&nbsp;5.2 agent authors it with the
					workflow tools, saves it to <span class="font-medium">{store.workflowName}</span>, and
					the canvas updates.
				</p>
			</div>
			{#if errorMessage}
				<p class="max-w-xs text-xs text-destructive">{errorMessage}</p>
			{/if}
			<button
				class="inline-flex items-center gap-1.5 rounded-md border border-fuchsia-400/30 bg-fuchsia-500/10 px-3 py-1.5 text-xs font-medium text-fuchsia-200 hover:bg-fuchsia-500/20 disabled:opacity-60"
				onclick={startSession}
				disabled={starting || !workflowId}
			>
				{#if starting}
					<Loader2 class="size-3.5 animate-spin" /> Starting…
				{:else}
					<Sparkles class="size-3.5" /> Start authoring session
				{/if}
			</button>
		</div>
	{:else}
		<div class="flex items-center justify-between border-b border-border px-2.5 py-1 text-[10px] text-muted-foreground">
			<span class="inline-flex items-center gap-1">
				<span class="size-1.5 rounded-full bg-fuchsia-400"></span> GLM 5.2 author
			</span>
			<div class="flex items-center gap-1">
				<a
					href={`/workspaces/${slug}/sessions/${sessionId}`}
					class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-accent"
					title="Open full session"
				>
					<ExternalLink class="size-3" /> Session
				</a>
				<button
					class="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 hover:bg-accent hover:text-destructive"
					onclick={resetSession}
					title="New authoring session"
				>
					<RotateCcw class="size-3" /> Reset
				</button>
			</div>
		</div>

		<div class="min-h-0 flex-1 overflow-hidden">
			<SessionTranscript {sessionId} compact showPulse={false} showTimeline={false} />
		</div>

		{#if errorMessage}
			<div class="border-t border-destructive/30 bg-destructive/10 px-3 py-1 text-[11px] text-destructive">
				{errorMessage}
			</div>
		{/if}

		<div class="border-t border-border p-2">
			<div class="flex items-end gap-1.5">
				<textarea
					bind:value={input}
					onkeydown={onKeydown}
					rows="2"
					placeholder="Describe the workflow you want…"
					class="flex-1 resize-none rounded-md border border-input bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
				></textarea>
				<button
					class="inline-flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
					onclick={send}
					disabled={sending || !input.trim()}
					title="Send"
				>
					{#if sending}
						<Loader2 class="size-3.5 animate-spin" />
					{:else}
						<Send class="size-3.5" />
					{/if}
				</button>
			</div>
		</div>
	{/if}
</div>

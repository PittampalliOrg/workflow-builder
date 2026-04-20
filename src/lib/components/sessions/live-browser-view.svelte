<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';

	let {
		sessionId,
		viewOnly = true,
		showWaking = false,
	}: {
		sessionId: string;
		/** Block client->server input (keyboard, pointer, clipboard) in the proxy. */
		viewOnly?: boolean;
		/** Hint from the parent that the agent-runtime is Starting, not Active. */
		showWaking?: boolean;
	} = $props();

	let container: HTMLDivElement | null = $state(null);
	let rfb: { disconnect: () => void; _rfbCleanup?: () => void } | null = null;
	let status = $state<'connecting' | 'connected' | 'disconnected' | 'error' | 'idle'>('idle');
	let message = $state<string | null>(null);
	let reconnectAttempt = $state(0);
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let destroyed = false;

	function backoffMs(): number {
		return Math.min(10_000, 1000 * Math.pow(2, reconnectAttempt));
	}

	async function connect() {
		if (destroyed || !container) return;
		status = 'connecting';
		message = null;

		try {
			// Dynamic import keeps noVNC out of the main bundle for pages that
			// don't use it. @novnc/novnc ships ~300KB minified.
			const { default: RFB } = await import('@novnc/novnc/lib/rfb.js');

			// Reset any prior child.
			container.innerHTML = '';

			const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
			const wsUrl = `${proto}//${location.host}/api/v1/sessions/${encodeURIComponent(sessionId)}/browser/vnc?viewOnly=${viewOnly ? 1 : 0}`;

			const client = new RFB(container, wsUrl);
			client.viewOnly = viewOnly;
			client.scaleViewport = true;
			client.resizeSession = false;

			// TigerVNC (Xtigervnc) on the server side rejects SetPixelFormat
			// requests for anything other than its native rgb888 with
			// "invalid pixel format", closing the socket mid-frame. noVNC
			// otherwise sends a bgr888 preference post-handshake because
			// HTMLCanvas is little-endian BGRA. Neutralize the method so
			// the client keeps the server's default rgb888 (noVNC transcodes
			// at paint time either way — the perf cost is negligible).
			const internal = client as unknown as { _sendSetPixelFormat?: () => void };
			if (typeof internal._sendSetPixelFormat === 'function') {
				internal._sendSetPixelFormat = () => {};
			}

			client.addEventListener('connect', () => {
				status = 'connected';
				reconnectAttempt = 0;
				message = null;
			});
			client.addEventListener('disconnect', (e: CustomEvent<{ clean: boolean }>) => {
				if (destroyed) return;
				status = e.detail?.clean ? 'disconnected' : 'error';
				message = e.detail?.clean ? 'Session ended.' : 'Connection lost.';
				scheduleReconnect();
			});
			client.addEventListener('securityfailure', () => {
				status = 'error';
				message = 'Authorization failed.';
			});

			rfb = client as unknown as typeof rfb;
		} catch (err) {
			status = 'error';
			message = err instanceof Error ? err.message : String(err);
			scheduleReconnect();
		}
	}

	function scheduleReconnect() {
		if (destroyed) return;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		const delay = backoffMs();
		reconnectAttempt++;
		reconnectTimer = setTimeout(() => {
			connect();
		}, delay);
	}

	function disconnect() {
		if (reconnectTimer) {
			clearTimeout(reconnectTimer);
			reconnectTimer = null;
		}
		if (rfb) {
			try {
				rfb.disconnect();
			} catch {
				/* noop */
			}
			rfb = null;
		}
	}

	onMount(() => {
		connect();
	});

	onDestroy(() => {
		destroyed = true;
		disconnect();
	});
</script>

<div class="flex h-full flex-col gap-2">
	<div class="flex items-center justify-between gap-2 text-xs">
		<div class="flex items-center gap-2">
			<span
				class="inline-block size-2 rounded-full {status === 'connected'
					? 'bg-emerald-500'
					: status === 'connecting'
						? 'bg-amber-500 animate-pulse'
						: 'bg-muted-foreground/40'}"
				aria-hidden="true"
			></span>
			<span class="text-muted-foreground">
				{#if status === 'connected'}
					Live{#if viewOnly}
						<span class="ml-1 text-muted-foreground/70">(view-only)</span>
					{/if}
				{:else if status === 'connecting'}
					Connecting…
				{:else if showWaking}
					Waking agent…
				{:else if status === 'disconnected'}
					Disconnected
				{:else if status === 'error'}
					Reconnecting…
				{:else}
					Idle
				{/if}
			</span>
			{#if message}
				<span class="text-muted-foreground/70">— {message}</span>
			{/if}
		</div>
		{#if status === 'error' || status === 'disconnected'}
			<Button
				variant="ghost"
				size="sm"
				class="h-6 gap-1 text-xs"
				onclick={() => {
					if (reconnectTimer) clearTimeout(reconnectTimer);
					reconnectAttempt = 0;
					connect();
				}}>Retry now</Button
			>
		{/if}
	</div>

	<div
		bind:this={container}
		role="img"
		aria-label="Live browser view of agent session {sessionId}"
		class="flex-1 min-h-[400px] overflow-hidden rounded-md border bg-black"
	></div>
</div>

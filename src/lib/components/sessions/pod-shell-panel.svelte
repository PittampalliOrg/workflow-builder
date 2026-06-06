<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { Xterm, XtermAddon } from '@battlefieldduck/xterm-svelte';
	import type { Terminal, ITerminalOptions } from '@battlefieldduck/xterm-svelte';

	type Props = {
		sessionId: string;
		/** Ready container names from runtime-flags; the user picks one. */
		containers: string[];
	};
	let { sessionId, containers }: Props = $props();

	interface TerminalFitAddon {
		activate: (terminal: Terminal) => void;
		fit: () => void;
		dispose: () => void;
	}

	// Preference order for the initial pick: chromium first, then the MCP
	// sidecar, then the agent runtime. Kept outside the component render so
	// it's referentially stable.
	const PREFERRED = ['chromium', 'playwright-mcp', 'claude-agent-py', 'dapr-agent-py'];

	// Static options — declared once at module scope so prop reactivity in
	// the parent never churns the Xterm component via a fresh reference.
	const xtermOptions: ITerminalOptions = {
		fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
		fontSize: 13,
		lineHeight: 1.2,
		cursorBlink: true,
		cursorStyle: 'bar',
		scrollback: 5000,
		theme: {
			background: '#09090b',
			foreground: '#fafafa',
			cursor: '#fafafa',
			selectionBackground: '#3f3f46',
		},
	};

	// ---- State ----
	let selectedContainer = $state(
		PREFERRED.find((c) => containers.includes(c)) ?? containers[0] ?? '',
	);
	/** High-level connection phase surfaced to the user — rendered as a
	 *  small badge above the terminal rather than as writeln() spam. That
	 *  single source of truth avoids the "flashing" effect that came from
	 *  the terminal scrolling a new "Disconnected / Reconnecting / Connecting"
	 *  banner on every reconnect cycle. */
	let connectionState = $state<'connecting' | 'open' | 'reconnecting' | 'closed'>('connecting');
	let lastCloseReason = $state<string | null>(null);

	// ---- Refs ----
	let terminal: Terminal | undefined;
	let terminalFrame: HTMLDivElement | null = null;
	let ws: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let fitAnimationFrame = 0;
	let fitAddon: TerminalFitAddon | null = null;
	let frameObserver: ResizeObserver | null = null;
	let resizeSubscription: { dispose?: () => void } | null = null;
	let attachAddon: { activate: (t: Terminal) => void; dispose: () => void } | null = null;
	let sendTerminalResize: ((cols: number, rows: number) => void) | null = null;
	let reconnectDelay = 1000;
	let intentionalClose = false;
	let destroyed = false;
	const MAX_RECONNECT_DELAY = 15000;

	function buildWsUrl(container: string): string {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${proto}//${location.host}/api/v1/sessions/${encodeURIComponent(sessionId)}/shell?container=${encodeURIComponent(container)}`;
	}

	function disposeBindings() {
		attachAddon?.dispose?.();
		attachAddon = null;
		resizeSubscription?.dispose?.();
		resizeSubscription = null;
		sendTerminalResize = null;
	}

	function fitTerminal(): boolean {
		if (!terminalFrame || !fitAddon || !terminalFrame.offsetWidth || !terminalFrame.offsetHeight) {
			return false;
		}
		try {
			fitAddon.fit();
		} catch {
			return false;
		}
		if (terminal && sendTerminalResize) sendTerminalResize(terminal.cols, terminal.rows);
		return true;
	}

	/** Coalesce multiple fit requests (ResizeObserver storms, socket-open +
	 *  addon-load overlap) into a single RAF-driven fit so we only
	 *  re-render the xterm grid once per animation frame. */
	function scheduleFit() {
		if (fitAnimationFrame) return;
		fitAnimationFrame = requestAnimationFrame(() => {
			fitAnimationFrame = 0;
			fitTerminal();
		});
	}

	async function connect(container: string) {
		if (!terminal || destroyed) return;
		// Tear down any previous socket first.
		if (ws) {
			try {
				ws.close();
			} catch {
				/* noop */
			}
			ws = null;
		}
		disposeBindings();
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = null;

		connectionState = 'connecting';
		lastCloseReason = null;

		const socket = new WebSocket(buildWsUrl(container));
		socket.binaryType = 'arraybuffer';
		ws = socket;

		// Lazy-load AttachAddon once per connect.
		const { AttachAddon } = await XtermAddon.AttachAddon();
		if (destroyed || ws !== socket) return;

		socket.onopen = () => {
			if (!terminal) return;
			reconnectDelay = 1000;
			connectionState = 'open';
			attachAddon = new AttachAddon(socket, { bidirectional: true });
			terminal.loadAddon(attachAddon);

			sendTerminalResize = (cols: number, rows: number) => {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(`\x01${JSON.stringify({ type: 'resize', cols, rows })}`);
				}
			};
			resizeSubscription = terminal.onResize(({ cols, rows }) => sendTerminalResize!(cols, rows));
			scheduleFit();
			sendTerminalResize(terminal.cols, terminal.rows);
		};

		socket.onclose = (ev) => {
			disposeBindings();
			if (intentionalClose || destroyed) {
				connectionState = 'closed';
				return;
			}
			lastCloseReason = ev.reason || null;
			connectionState = 'reconnecting';
			if (reconnectTimer) clearTimeout(reconnectTimer);
			reconnectTimer = setTimeout(() => {
				reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
				connect(selectedContainer);
			}, reconnectDelay);
		};

		socket.onerror = () => {
			// onclose follows naturally; state transitions there.
		};
	}

	async function onLoad(term: Terminal) {
		terminal = term;
		const { FitAddon } = await XtermAddon.FitAddon();
		if (destroyed) return;
		fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		await tick();
		scheduleFit();
		if (terminalFrame) {
			// Debounced to absorb resize storms during layout.
			frameObserver = new ResizeObserver(() => {
				if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
				resizeDebounceTimer = setTimeout(() => scheduleFit(), 80);
			});
			frameObserver.observe(terminalFrame);
		}
		// Intro banner — written once per mount, not on every reconnect.
		term.writeln('\x1b[32m╭─ Pod shell ─╮\x1b[0m');
		term.writeln('');
		connect(selectedContainer);
	}

	/** Container switcher: tear down current WS, open a new one, leave the
	 *  terminal buffer intact so the user's scroll history survives. */
	function switchContainer(next: string) {
		if (!next || next === selectedContainer || !terminal) return;
		selectedContainer = next;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = null;
		// Visually separate the two sessions without clearing the buffer.
		terminal.writeln('');
		terminal.writeln(`\x1b[90m── switching to ${next} ──\x1b[0m`);
		connect(next);
	}

	// ---- Svelte 5 lifecycle via $effect ----
	$effect(() => {
		const onWindowResize = () => scheduleFit();
		window.addEventListener('resize', onWindowResize);
		return () => {
			destroyed = true;
			intentionalClose = true;
			window.removeEventListener('resize', onWindowResize);
			if (reconnectTimer) clearTimeout(reconnectTimer);
			if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
			if (fitAnimationFrame) cancelAnimationFrame(fitAnimationFrame);
			frameObserver?.disconnect();
			fitAddon?.dispose?.();
			disposeBindings();
			if (ws) {
				try {
					ws.close();
				} catch {
					/* noop */
				}
				ws = null;
			}
		};
	});

	// Keep `selectedContainer` valid when the parent's `containers` prop
	// changes (e.g., pod restarts and a container drops). `untrack` prevents
	// a feedback loop — we only want to react to the prop, not the state.
	$effect(() => {
		if (containers.length === 0) return;
		if (!containers.includes(untrack(() => selectedContainer))) {
			const fallback = PREFERRED.find((c) => containers.includes(c)) ?? containers[0];
			if (fallback) {
				selectedContainer = fallback;
				if (terminal) connect(fallback);
			}
		}
	});

	const statusLabel = $derived.by(() => {
		if (connectionState === 'open') return 'Connected';
		if (connectionState === 'connecting') return 'Connecting…';
		if (connectionState === 'reconnecting')
			return `Reconnecting${lastCloseReason ? ` — ${lastCloseReason}` : '…'}`;
		return 'Closed';
	});
	const statusTone = $derived(
		connectionState === 'open'
			? 'bg-emerald-500'
			: connectionState === 'connecting' || connectionState === 'reconnecting'
				? 'bg-amber-500 animate-pulse'
				: 'bg-muted-foreground/40',
	);
</script>

<div class="flex h-full flex-col gap-2">
	<div class="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
		<span class="font-medium text-muted-foreground">Container</span>
		<select
			class="border border-border rounded px-2 py-0.5 bg-background"
			value={selectedContainer}
			onchange={(e) => switchContainer((e.target as HTMLSelectElement).value)}
		>
			{#each containers as c (c)}
				<option value={c}>{c}</option>
			{/each}
		</select>
		<span class="ml-2 inline-flex items-center gap-1.5" aria-live="polite">
			<span class="inline-block size-2 shrink-0 rounded-full {statusTone}" aria-hidden="true"></span>
			<span class="text-muted-foreground">{statusLabel}</span>
		</span>
		<span class="ml-auto text-muted-foreground/70 truncate">bash if available, else /bin/sh</span>
	</div>

	<div
		bind:this={terminalFrame}
		class="pod-shell-frame flex-1 min-h-0 overflow-hidden rounded-md border bg-[#09090b] p-1"
	>
		<Xterm class="h-full w-full" options={xtermOptions} {onLoad} />
	</div>
</div>

<style>
	.pod-shell-frame :global(.xterm) {
		height: 100%;
		width: 100%;
	}
	.pod-shell-frame :global(.xterm-viewport),
	.pod-shell-frame :global(.xterm-screen) {
		height: 100% !important;
	}
</style>

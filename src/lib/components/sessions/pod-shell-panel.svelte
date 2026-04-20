<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Xterm, XtermAddon } from '@battlefieldduck/xterm-svelte';
	import type { Terminal, ITerminalOptions } from '@battlefieldduck/xterm-svelte';

	let {
		sessionId,
		containers,
	}: {
		sessionId: string;
		/** Ready container names from runtime-flags; the user picks one. */
		containers: string[];
	} = $props();

	interface TerminalFitAddon {
		activate: (terminal: Terminal) => void;
		fit: () => void;
		dispose: () => void;
	}

	// Default to a sensible first container. Preference order is
	// chromium > playwright-mcp > dapr-agent-py (most likely "what do I
	// want to inspect" for a browser agent).
	const PREFERRED = ['chromium', 'playwright-mcp', 'dapr-agent-py'];
	const initialContainer =
		PREFERRED.find((c) => containers.includes(c)) ?? containers[0] ?? '';
	let selectedContainer = $state(initialContainer);

	let terminal = $state<Terminal>();
	let terminalFrame: HTMLDivElement | null = null;
	let ws: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let fitRetryTimer: ReturnType<typeof setTimeout> | null = null;
	let fitAnimationFrame = 0;
	let fitAddon: TerminalFitAddon | null = null;
	let frameObserver: ResizeObserver | null = null;
	let resizeSubscription: { dispose?: () => void } | null = null;
	let attachAddon: { activate: (terminal: Terminal) => void; dispose: () => void } | null = null;
	let sendTerminalResize: ((cols: number, rows: number) => void) | null = null;
	let reconnectDelay = 1000;
	let intentionalClose = false;
	const MAX_RECONNECT_DELAY = 15000;

	const options: ITerminalOptions = {
		fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
		fontSize: 13,
		lineHeight: 1.2,
		cursorBlink: true,
		cursorStyle: 'bar',
		theme: {
			background: '#09090b',
			foreground: '#fafafa',
			cursor: '#fafafa',
			selectionBackground: '#3f3f46'
		}
	};

	function getWsUrl(): string {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${proto}//${location.host}/api/v1/sessions/${encodeURIComponent(sessionId)}/shell?container=${encodeURIComponent(selectedContainer)}`;
	}

	function disposeBindings() {
		attachAddon?.dispose?.();
		attachAddon = null;
		resizeSubscription?.dispose?.();
		resizeSubscription = null;
		sendTerminalResize = null;
	}

	function clearPendingFits() {
		if (fitAnimationFrame) {
			cancelAnimationFrame(fitAnimationFrame);
			fitAnimationFrame = 0;
		}
		if (fitRetryTimer) {
			clearTimeout(fitRetryTimer);
			fitRetryTimer = null;
		}
	}

	function fitTerminal(): boolean {
		if (!terminalFrame || !fitAddon || !terminalFrame.offsetWidth || !terminalFrame.offsetHeight) {
			return false;
		}
		fitAddon.fit();
		if (terminal && sendTerminalResize) {
			sendTerminalResize(terminal.cols, terminal.rows);
		}
		return true;
	}

	function queueFit(retry = true) {
		clearPendingFits();
		fitAnimationFrame = requestAnimationFrame(() => {
			fitAnimationFrame = 0;
			const fitted = fitTerminal();
			if (!fitted && retry) {
				fitRetryTimer = setTimeout(() => queueFit(false), 75);
			}
		});
	}

	async function connect(term: Terminal, options: { resetDisplay?: boolean } = {}) {
		if (ws) {
			ws.close();
			ws = null;
		}
		disposeBindings();
		if (options.resetDisplay) {
			term.clear();
			term.writeln(`\x1b[32mPod shell\x1b[0m \x1b[90m[${selectedContainer}]\x1b[0m`);
			term.writeln('');
		}
		term.writeln('\x1b[90mConnecting…\x1b[0m');

		const socket = new WebSocket(getWsUrl());
		socket.binaryType = 'arraybuffer';
		ws = socket;

		const { AttachAddon } = await XtermAddon.AttachAddon();

		socket.onopen = () => {
			reconnectDelay = 1000;
			attachAddon = new AttachAddon(socket, { bidirectional: true });
			term.loadAddon(attachAddon);

			const sendResize = (cols: number, rows: number) => {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(`\x01${JSON.stringify({ type: 'resize', cols, rows })}`);
				}
			};
			sendTerminalResize = sendResize;
			resizeSubscription = term.onResize(({ cols, rows }) => sendResize(cols, rows));
			queueFit();
			sendResize(term.cols, term.rows);
		};

		socket.onclose = (ev) => {
			disposeBindings();
			if (intentionalClose) return;
			term.writeln('');
			term.writeln(
				`\x1b[90mDisconnected${ev.reason ? ': ' + ev.reason : ''} (code ${ev.code})\x1b[0m`,
			);
			scheduleReconnect(term);
		};

		socket.onerror = () => {
			// onclose follows
		};
	}

	function scheduleReconnect(term: Terminal) {
		if (intentionalClose) return;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		term.writeln(`\x1b[90mReconnecting in ${reconnectDelay / 1000}s…\x1b[0m`);
		reconnectTimer = setTimeout(() => {
			reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
			connect(term, { resetDisplay: true });
		}, reconnectDelay);
	}

	async function onLoad(term: Terminal) {
		terminal = term;

		const { FitAddon } = await XtermAddon.FitAddon();
		fitAddon = new FitAddon();
		term.loadAddon(fitAddon);

		await tick();
		queueFit();

		if (terminalFrame) {
			frameObserver = new ResizeObserver(() => queueFit());
			frameObserver.observe(terminalFrame);
		}

		term.writeln(`\x1b[32mPod shell\x1b[0m \x1b[90m[${selectedContainer}]\x1b[0m`);
		term.writeln('');
		connect(term);
	}

	function switchContainer(next: string) {
		if (!next || next === selectedContainer) return;
		selectedContainer = next;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		if (terminal) {
			connect(terminal, { resetDisplay: true });
		}
	}

	onMount(() => {
		const onWindowResize = () => queueFit();
		window.addEventListener('resize', onWindowResize);
		return () => {
			intentionalClose = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			clearPendingFits();
			frameObserver?.disconnect();
			fitAddon?.dispose?.();
			disposeBindings();
			window.removeEventListener('resize', onWindowResize);
			if (ws) {
				ws.close();
				ws = null;
			}
		};
	});
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
		<span class="ml-auto text-muted-foreground/70">
			Shell opens bash if available, else /bin/sh
		</span>
	</div>

	<div
		bind:this={terminalFrame}
		class="pod-shell-frame flex-1 min-h-0 overflow-hidden rounded-md border bg-[#09090b] p-1"
	>
		<Xterm class="h-full w-full" {options} {onLoad} />
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

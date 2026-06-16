<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Xterm, XtermAddon } from '@battlefieldduck/xterm-svelte';
	import type { Terminal, ITerminalOptions } from '@battlefieldduck/xterm-svelte';
	import { Mouse, TextSelect } from '@lucide/svelte';

	interface Props {
		sandboxName: string;
		sessionId: string;
		active?: boolean;
		wsPath?: string;
	}

	interface TerminalFitAddon {
		activate: (terminal: Terminal) => void;
		fit: () => void;
		dispose: () => void;
	}

	let { sandboxName, sessionId, active = true, wsPath }: Props = $props();

	let terminal = $state<Terminal>();
	let terminalFrame: HTMLDivElement | null = null;
	let ws: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let firstMessageTimer: ReturnType<typeof setTimeout> | null = null;
	let fitRetryTimer: ReturnType<typeof setTimeout> | null = null;
	let fitAnimationFrame = 0;
	let fitAddon: TerminalFitAddon | null = null;
	let frameObserver: ResizeObserver | null = null;
	let resizeSubscription: { dispose?: () => void } | null = null;
	let attachAddon: { activate: (terminal: Terminal) => void; dispose: () => void } | null = null;
	let sendTerminalResize: ((cols: number, rows: number) => void) | null = null;
	let reconnectDelay = 1000;
	let intentionalClose = false;

	// Mouse mode toggle (scroll vs select). The interactive CLIs enable
	// application MOUSE REPORTING; with it ON, xterm forwards the wheel to the
	// TUI so scrolling moves the TUI's content (and clicks work) — but you can't
	// drag-select text. With it OFF, xterm does local drag-to-select/copy. xterm
	// can't do both at once, so we expose a toggle. Scroll mode is the DEFAULT
	// (the common case); flip to Select mode to copy text (e.g. a sign-in URL).
	let mouseSelectMode = $state(false); // false = scroll (mouse→TUI), true = select
	// DEC private modes the TUI has asked to enable (recorded so the toggle can
	// replay them into xterm when switching modes).
	const appMouseModes = new Set<number>();
	let replayingMouseMode = false;
	// Mouse-tracking DEC private modes (button/any-event tracking + SGR/ext
	// encodings). NOT alt-screen/paste/cursor — those are always honored.
	const MOUSE_MODES = new Set([1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);

	/** Re-assert the TUI's requested mouse modes into xterm to match the toggle:
	 *  Scroll mode replays the enables (wheel→TUI); Select mode replays disables
	 *  (xterm reclaims the mouse for local selection). */
	function syncMouseMode() {
		if (!terminal || appMouseModes.size === 0) return;
		const suffix = mouseSelectMode ? 'l' : 'h';
		const seq = [...appMouseModes].map((m) => `\x1b[?${m}${suffix}`).join('');
		replayingMouseMode = true;
		terminal.write(seq, () => {
			replayingMouseMode = false;
		});
	}

	function toggleMouseMode() {
		mouseSelectMode = !mouseSelectMode;
		syncMouseMode();
		terminal?.focus();
	}

	const MAX_RECONNECT_DELAY = 30000;
	// Cold-start tolerant: the interactive-CLI pods (esp. agy) can take a while to
	// boot and attach the TUI pane before any bytes flow. A short timeout here turns
	// a slow boot into a reconnect storm (repeated "Connecting…" + screen clears =
	// the glitchy/dark flashing). Keep a watchdog, but a generous one.
	const FIRST_MESSAGE_TIMEOUT_MS = 20000;

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
			selectionBackground: '#3f3f46',
			black: '#09090b',
			red: '#ef4444',
			green: '#22c55e',
			yellow: '#eab308',
			blue: '#3b82f6',
			magenta: '#a855f7',
			cyan: '#06b6d4',
			white: '#fafafa',
			brightBlack: '#71717a',
			brightRed: '#f87171',
			brightGreen: '#4ade80',
			brightYellow: '#facc15',
			brightBlue: '#60a5fa',
			brightMagenta: '#c084fc',
			brightCyan: '#22d3ee',
			brightWhite: '#ffffff'
		}
	};

	function getWsUrl(): string {
		const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
		if (wsPath) return `${proto}//${location.host}${wsPath}`;
		return `${proto}//${location.host}/api/sandboxes/${encodeURIComponent(sandboxName)}/terminal/${encodeURIComponent(sessionId)}`;
	}

	function clearFirstMessageTimer() {
		if (firstMessageTimer) {
			clearTimeout(firstMessageTimer);
			firstMessageTimer = null;
		}
	}

	function disposeTerminalBindings() {
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

	function renderTerminalBanner(term: Terminal) {
		term.clear();
		term.writeln('\x1b[32mOpenShell Sandbox Terminal\x1b[0m');
		term.writeln(`\x1b[90mSandbox: ${sandboxName}\x1b[0m`);
		term.writeln('');
	}

	async function connect(term: Terminal, options: { announce?: boolean } = {}) {
		if (ws) {
			ws.close();
			ws = null;
		}
		clearFirstMessageTimer();
		disposeTerminalBindings();

		// Only announce on the first connect. Reconnects keep the existing screen
		// (no clear, no banner, no duplicate "Connecting…") — the "Reconnecting…"
		// line already informs the user, and clearing on every retry is what made a
		// slow backend boot flash the terminal dark with stacked loading messages.
		if (options.announce !== false) {
			term.writeln('\x1b[90mConnecting to sandbox...\x1b[0m');
		}

		const socket = new WebSocket(getWsUrl());
		ws = socket;

		const { AttachAddon } = await XtermAddon.AttachAddon();

		socket.onopen = () => {
			reconnectDelay = 1000;
			let sawFirstMessage = false;
			attachAddon = new AttachAddon(socket, { bidirectional: true });
			term.loadAddon(attachAddon);
			socket.addEventListener('message', () => {
				if (!sawFirstMessage) {
					sawFirstMessage = true;
					clearFirstMessageTimer();
				}
			});
			firstMessageTimer = setTimeout(() => {
				if (!sawFirstMessage && socket.readyState === WebSocket.OPEN) {
					term.writeln('\x1b[90mNo terminal output yet; retrying...\x1b[0m');
					socket.close(1013, 'terminal startup timeout');
				}
			}, FIRST_MESSAGE_TIMEOUT_MS);

			// Send initial size and track resizes
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
			clearFirstMessageTimer();
			disposeTerminalBindings();
			if (intentionalClose) return;
			term.writeln('');
			term.writeln(
				`\x1b[90mDisconnected${ev.reason ? ': ' + ev.reason : ''} (code ${ev.code})\x1b[0m`
			);
			scheduleReconnect(term);
		};

		socket.onerror = () => {
			// onclose fires after
		};
	}

	function scheduleReconnect(term: Terminal) {
		if (intentionalClose) return;
		if (reconnectTimer) clearTimeout(reconnectTimer);

		term.writeln(`\x1b[90mReconnecting in ${reconnectDelay / 1000}s...\x1b[0m`);
		reconnectTimer = setTimeout(() => {
			reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
			connect(term, { announce: false });
		}, reconnectDelay);
	}

	async function onLoad(term: Terminal) {
		terminal = term;

		const { FitAddon } = await XtermAddon.FitAddon();
		fitAddon = new FitAddon();
		term.loadAddon(fitAddon);

		try {
			const { WebLinksAddon } = await XtermAddon.WebLinksAddon();
			term.loadAddon(new WebLinksAddon());
		} catch {
			// optional
		}

		// GPU renderer: the DOM renderer glitches on the heavy full-screen redraws
		// the CLIs do (agy's box-drawing + context grid, claude/codex spinners) —
		// torn rows, leftover cells. WebGL renders the whole grid to a canvas each
		// frame, which is far more stable. Fall back to the DOM renderer if the GL
		// context is unavailable or lost (headless/GPU-less clients).
		try {
			const { WebglAddon } = await XtermAddon.WebglAddon();
			const webgl = new WebglAddon();
			webgl.onContextLoss(() => {
				try {
					webgl.dispose();
				} catch {
					// already disposed
				}
				// Disposing reverts xterm to the DOM renderer, but the canvas can stay
				// blank ("goes dark") until something repaints — force a full refresh so
				// the terminal keeps rendering after a lost GL context.
				try {
					term.refresh(0, Math.max(0, term.rows - 1));
				} catch {
					// terminal gone
				}
			});
			term.loadAddon(webgl);
		} catch {
			// WebGL unavailable → DOM renderer (correct, just less crisp on redraws)
		}

		// Mouse-mode handling, gated by the scroll/select toggle. The interactive
		// CLIs enable application MOUSE REPORTING (private modes 1000–1016). In
		// SCROLL mode (default) we let xterm honor them so the wheel scrolls the
		// TUI's content and clicks register; in SELECT mode we swallow them so
		// drag-to-select/copy works (e.g. the agy sign-in URL). Every other
		// DECSET/DECRST (alt-screen 1049, bracketed paste 2004, cursor 25, …) is
		// left untouched. We record the TUI's requested modes so the toggle can
		// replay them into xterm when the user flips modes mid-session.
		const handleMouseDecMode =
			(enable: boolean) =>
			(params: (number | number[])[]): boolean => {
				const first = params[0];
				const mode = Array.isArray(first) ? first[0] : first;
				if (typeof mode !== 'number' || !MOUSE_MODES.has(mode)) return false; // not mouse → let xterm run
				if (replayingMouseMode) return false; // our own replay → let xterm apply it
				if (enable) appMouseModes.add(mode);
				else appMouseModes.delete(mode);
				// true → swallow (Select mode); false → let xterm enable (Scroll mode).
				return mouseSelectMode;
			};
		term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, handleMouseDecMode(true));
		term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, handleMouseDecMode(false));

		// xterm's selection lives on its canvas, not the DOM, so the browser's
		// native Copy can't see it. Mirror the selection into the clipboard as it's
		// made (copy-on-select) so the highlighted text — e.g. the OAuth URL — can
		// be pasted anywhere. Best-effort; silently ignored if clipboard is blocked.
		term.onSelectionChange(() => {
			const sel = term.getSelection();
			if (sel && sel.trim()) navigator.clipboard?.writeText(sel).catch(() => {});
		});

		await tick();
		queueFit();

		if (terminalFrame) {
			frameObserver = new ResizeObserver(() => queueFit());
			frameObserver.observe(terminalFrame);
		}

		renderTerminalBanner(term);
		connect(term);
	}

	$effect(() => {
		if (active) {
			queueFit();
		}
	});

	onMount(() => {
		const fitOnWindowResize = () => queueFit();
		window.addEventListener('resize', fitOnWindowResize);
		return () => {
			intentionalClose = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			clearFirstMessageTimer();
			clearPendingFits();
			frameObserver?.disconnect();
			fitAddon?.dispose?.();
			disposeTerminalBindings();
			window.removeEventListener('resize', fitOnWindowResize);
			if (ws) {
				ws.close();
				ws = null;
			}
			// The xterm-svelte wrapper creates the Terminal but never disposes it, so
			// without this every remount ({#key} reconnect, tab switch, navigation)
			// leaks a Terminal AND its WebGL context. Browsers cap live GL contexts
			// (~16) and silently kill the oldest, which is what makes terminals "go
			// dark." Disposing the terminal frees its addons (incl. WebGL) too.
			try {
				terminal?.dispose();
			} catch {
				// already disposed
			}
			terminal = undefined;
		};
	});
</script>

<div class="relative flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#09090b]">
	<button
		type="button"
		onclick={toggleMouseMode}
		class="absolute right-2 top-2 z-10 flex items-center gap-1 rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] text-zinc-300 opacity-60 backdrop-blur transition hover:bg-white/10 hover:opacity-100"
		title={mouseSelectMode
			? 'Select mode: drag to select/copy text. Click to switch to Scroll mode (mouse wheel scrolls the terminal).'
			: 'Scroll mode: mouse wheel scrolls the terminal & clicks work. Click to switch to Select mode (drag to copy text).'}
		aria-label="Toggle terminal mouse mode"
	>
		{#if mouseSelectMode}
			<TextSelect class="size-3" /> Select
		{:else}
			<Mouse class="size-3" /> Scroll
		{/if}
	</button>
	<div
		bind:this={terminalFrame}
		class="sandbox-terminal-frame min-h-0 flex-1 overflow-hidden p-1"
	>
		<Xterm class="h-full w-full" {options} {onLoad} />
	</div>
</div>

<style>
	.sandbox-terminal-frame :global(.xterm) {
		height: 100%;
		width: 100%;
	}

	.sandbox-terminal-frame :global(.xterm-viewport),
	.sandbox-terminal-frame :global(.xterm-screen) {
		height: 100% !important;
	}
</style>

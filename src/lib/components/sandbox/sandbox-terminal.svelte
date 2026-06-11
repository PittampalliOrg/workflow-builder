<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Xterm, XtermAddon } from '@battlefieldduck/xterm-svelte';
	import type { Terminal, ITerminalOptions } from '@battlefieldduck/xterm-svelte';
	import { toast } from 'svelte-sonner';
	import { AuthLinkDetector } from '$lib/utils/terminal-auth-links';

	interface Props {
		sandboxName: string;
		sessionId: string;
		active?: boolean;
		wsPath?: string;
		/**
		 * Watch terminal output for sign-in / OAuth URLs (e.g. the agy
		 * device-login link) and surface them as a toast with Copy / Open.
		 */
		surfaceAuthLinks?: boolean;
	}

	interface TerminalFitAddon {
		activate: (terminal: Terminal) => void;
		fit: () => void;
		dispose: () => void;
	}

	let {
		sandboxName,
		sessionId,
		active = true,
		wsPath,
		surfaceAuthLinks = false
	}: Props = $props();

	let authLinkDetector: AuthLinkDetector | null = null;
	let authLinkDecoder: TextDecoder | null = null;

	function showAuthLinkToast(url: string) {
		toast.info('Sign-in link detected', {
			description: url,
			duration: Number.POSITIVE_INFINITY,
			action: {
				label: 'Open',
				onClick: () => window.open(url, '_blank', 'noopener,noreferrer')
			},
			cancel: {
				label: 'Copy',
				onClick: async () => {
					try {
						await navigator.clipboard.writeText(url);
						toast.success('Sign-in link copied');
					} catch {
						toast.error('Could not copy link');
					}
				}
			}
		});
	}

	function feedAuthLinkDetector(data: unknown) {
		if (!surfaceAuthLinks) return;
		const detector = (authLinkDetector ??= new AuthLinkDetector());
		const decoder = (authLinkDecoder ??= new TextDecoder('utf-8', { fatal: false }));
		const emit = (text: string) => {
			for (const url of detector.push(text)) showAuthLinkToast(url);
		};
		if (typeof data === 'string') emit(data);
		else if (data instanceof ArrayBuffer) emit(decoder.decode(new Uint8Array(data)));
		else if (data instanceof Blob) data.text().then(emit).catch(() => {});
	}

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

	const MAX_RECONNECT_DELAY = 30000;
	const FIRST_MESSAGE_TIMEOUT_MS = 4000;

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

	async function connect(term: Terminal, options: { resetDisplay?: boolean } = {}) {
		if (ws) {
			ws.close();
			ws = null;
		}
		clearFirstMessageTimer();
		disposeTerminalBindings();
		if (options.resetDisplay) {
			renderTerminalBanner(term);
		}

		term.writeln('\x1b[90mConnecting to sandbox...\x1b[0m');

		const socket = new WebSocket(getWsUrl());
		ws = socket;

		const { AttachAddon } = await XtermAddon.AttachAddon();

		socket.onopen = () => {
			reconnectDelay = 1000;
			let sawFirstMessage = false;
			attachAddon = new AttachAddon(socket, { bidirectional: true });
			term.loadAddon(attachAddon);
			socket.addEventListener('message', (evt) => {
				if (!sawFirstMessage) {
					sawFirstMessage = true;
					clearFirstMessageTimer();
				}
				feedAuthLinkDetector(evt.data);
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
			connect(term, { resetDisplay: true });
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
		};
	});
</script>

<div class="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#09090b]">
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

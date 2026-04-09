<script lang="ts">
	import { Xterm, XtermAddon } from '@battlefieldduck/xterm-svelte';
	import type { Terminal, ITerminalOptions } from '@battlefieldduck/xterm-svelte';

	interface Props {
		sandboxName: string;
	}

	let { sandboxName }: Props = $props();

	let terminal = $state<Terminal>();
	let lineBuffer = '';
	let running = false;

	const options: ITerminalOptions = {
		fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
		fontSize: 13,
		lineHeight: 1.2,
		cursorBlink: true,
		cursorStyle: 'bar',
		convertEol: true,
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

	async function onLoad(term: Terminal) {
		terminal = term;

		const { FitAddon } = await XtermAddon.FitAddon();
		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);

		try {
			const { WebLinksAddon } = await XtermAddon.WebLinksAddon();
			terminal.loadAddon(new WebLinksAddon());
		} catch {
			// optional
		}

		fitAddon.fit();

		const container = terminal.element?.parentElement;
		if (container) {
			new ResizeObserver(() => fitAddon.fit()).observe(container);
		}

		terminal.writeln('\x1b[32mOpenShell Sandbox Terminal\x1b[0m');
		terminal.writeln(`\x1b[90mSandbox: ${sandboxName}\x1b[0m`);
		terminal.writeln('');
		writePrompt();
	}

	function writePrompt() {
		terminal?.write('\x1b[36msandbox\x1b[0m:\x1b[34m~\x1b[0m$ ');
	}

	async function executeCommand(command: string) {
		if (!command.trim()) {
			writePrompt();
			return;
		}

		running = true;

		try {
			const response = await fetch(
				`/api/sandboxes/${encodeURIComponent(sandboxName)}/exec?stream=true`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ command: command.trim(), timeout: 30 })
				}
			);

			if (!response.ok || !response.body) {
				terminal?.writeln(`\x1b[31mError: ${response.statusText}\x1b[0m`);
				writePrompt();
				running = false;
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			let streamDone = false;

			while (!streamDone) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				let eventType = '';
				for (const line of lines) {
					if (line.startsWith('event: ')) {
						eventType = line.slice(7).trim();
					} else if (line.startsWith('data: ')) {
						const raw = line.slice(6);
						try {
							const data = JSON.parse(raw);
							if (eventType === 'stdout') {
								terminal?.write(data.text ?? '');
							} else if (eventType === 'stderr') {
								terminal?.write(`\x1b[31m${data.text ?? ''}\x1b[0m`);
							} else if (eventType === 'exit') {
								const code = data.exitCode ?? 0;
								if (code !== 0) {
									terminal?.writeln(`\x1b[90m(exit ${code})\x1b[0m`);
								}
							} else if (eventType === 'error') {
								terminal?.writeln(`\x1b[31mError: ${data.message ?? 'unknown'}\x1b[0m`);
							} else if (eventType === 'done') {
								streamDone = true;
								break;
							}
						} catch {
							// ignore unparseable
						}
						eventType = '';
					}
				}
			}

			// Cancel the reader if still open
			try { reader.cancel(); } catch { /* */ }
		} catch (err) {
			terminal?.writeln(
				`\x1b[31mConnection error: ${err instanceof Error ? err.message : 'unknown'}\x1b[0m`
			);
		} finally {
			running = false;
			writePrompt();
		}
	}

	function onData(data: string) {
		if (!terminal) return;

		// Handle special keys
		const code = data.charCodeAt(0);

		if (code === 13) {
			// Enter
			terminal.write('\r\n');
			const cmd = lineBuffer;
			lineBuffer = '';
			executeCommand(cmd);
		} else if (code === 127 || code === 8) {
			// Backspace
			if (lineBuffer.length > 0) {
				lineBuffer = lineBuffer.slice(0, -1);
				terminal.write('\b \b');
			}
		} else if (code === 3) {
			// Ctrl+C
			lineBuffer = '';
			terminal.write('^C\r\n');
			if (!running) writePrompt();
		} else if (code === 12) {
			// Ctrl+L (clear)
			terminal.clear();
			writePrompt();
		} else if (code === 21) {
			// Ctrl+U (clear line)
			const len = lineBuffer.length;
			lineBuffer = '';
			terminal.write('\r\x1b[K');
			writePrompt();
		} else if (code >= 32) {
			// Printable character
			if (!running) {
				lineBuffer += data;
				terminal.write(data);
			}
		}
	}
</script>

<div class="flex h-full flex-col overflow-hidden bg-[#09090b]">
	<div class="flex-1 overflow-hidden p-1">
		<Xterm {options} {onLoad} {onData} />
	</div>
</div>

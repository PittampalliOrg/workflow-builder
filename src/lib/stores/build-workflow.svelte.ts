/**
 * Store for the /build-workflow autonomous agent.
 * Tracks build progress, handles SSE events, manages the iteration loop state.
 */

export type BuildPhase = 'idle' | 'loading' | 'generating' | 'parsing' | 'saving' | 'executing' | 'running' | 'fixing' | 'complete' | 'failed' | 'error';

export interface StepResult {
	name: string;
	status: string;
	error?: string | null;
	input?: unknown;
	output?: unknown;
	durationMs?: number;
}

export interface BuildLogEntry {
	timestamp: string;
	type: 'status' | 'spec' | 'result' | 'iteration' | 'done';
	data: unknown;
}

export function createBuildWorkflowStore() {
	let phase = $state<BuildPhase>('idle');
	let message = $state('');
	let attempt = $state(0);
	let maxAttempts = $state(5);
	let currentSpecYaml = $state<string | null>(null);
	let currentSpec = $state<Record<string, unknown> | null>(null);
	/** Increments each time a new spec is received from the agent, used as a change signal */
	let specVersion = $state(0);
	let steps = $state<StepResult[]>([]);
	let success = $state<boolean | null>(null);
	let executionId = $state<string | null>(null);
	let log = $state<BuildLogEntry[]>([]);
	let isRunning = $state(false);
	let abortController: AbortController | null = null;

	function addLog(type: BuildLogEntry['type'], data: unknown) {
		log = [...log, { timestamp: new Date().toISOString(), type, data }];
	}

	async function start(workflowId: string, prompt: string) {
		if (isRunning) return;

		// Reset state
		phase = 'loading';
		message = 'Starting...';
		attempt = 0;
		currentSpecYaml = null;
		steps = [];
		success = null;
		executionId = null;
		log = [];
		isRunning = true;

		abortController = new AbortController();

		try {
			const response = await fetch('/api/ai-assistant/build-workflow', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ prompt, workflowId }),
				signal: abortController.signal,
			});

			if (!response.ok) {
				phase = 'error';
				message = await response.text();
				isRunning = false;
				return;
			}

			const reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = '';

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const blocks = buffer.split('\n\n');
				buffer = blocks.pop() || '';

				for (const block of blocks) {
					if (!block.trim()) continue;
					const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
					const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
					if (!dataLine) continue;

					const eventType = eventLine?.slice(7).trim() || 'status';
					const dataStr = dataLine.slice(6);

					try {
						const data = JSON.parse(dataStr);
						addLog(eventType as BuildLogEntry['type'], data);

						switch (eventType) {
							case 'status':
								phase = (data.phase || 'loading') as BuildPhase;
								message = data.message || '';
								break;
							case 'spec':
								currentSpecYaml = data.yaml || null;
								// Parse YAML to object for canvas updates
								if (data.yaml) {
									try {
										const { default: yaml } = await import('js-yaml');
										const parsed = yaml.load(data.yaml) as Record<string, unknown>;
										if (parsed && typeof parsed === 'object' && parsed.document) {
											currentSpec = parsed;
											specVersion++;
										}
									} catch { /* invalid yaml */ }
								}
								break;
							case 'result':
								steps = data.steps || [];
								break;
							case 'iteration':
								attempt = data.attempt || 0;
								maxAttempts = data.maxAttempts || 5;
								break;
							case 'done':
								success = data.success || false;
								executionId = data.executionId || null;
								if (data.spec && typeof data.spec === 'object') {
									currentSpec = data.spec as Record<string, unknown>;
									specVersion++;
								}
								if (data.success) phase = 'complete';
								else phase = 'failed';
								break;
						}
					} catch { /* skip malformed */ }
				}
			}
		} catch (err) {
			if (err instanceof Error && err.name === 'AbortError') {
				phase = 'idle';
				message = 'Cancelled';
			} else {
				phase = 'error';
				message = err instanceof Error ? err.message : 'Build failed';
			}
		} finally {
			isRunning = false;
			abortController = null;
		}
	}

	function stop() {
		abortController?.abort();
	}

	function reset() {
		phase = 'idle';
		message = '';
		attempt = 0;
		currentSpecYaml = null;
		currentSpec = null;
		specVersion = 0;
		steps = [];
		success = null;
		executionId = null;
		log = [];
		isRunning = false;
	}

	return {
		get phase() { return phase; },
		get message() { return message; },
		get attempt() { return attempt; },
		get maxAttempts() { return maxAttempts; },
		get currentSpecYaml() { return currentSpecYaml; },
		get currentSpec() { return currentSpec; },
		get specVersion() { return specVersion; },
		get steps() { return steps; },
		get success() { return success; },
		get executionId() { return executionId; },
		get log() { return log; },
		get isRunning() { return isRunning; },

		start,
		stop,
		reset,
	};
}

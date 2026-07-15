import type { RuntimeHandoffIdentity } from '$lib/types/runtime-handoff';

const RUNTIME_HANDOFF_ENDPOINT = '/api/runtime-handoff';

export function isRuntimeHandoffIdentity(value: unknown): value is RuntimeHandoffIdentity {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<RuntimeHandoffIdentity>;
	return (
		typeof candidate.watch === 'boolean' &&
		(candidate.previewName === null || typeof candidate.previewName === 'string') &&
		(candidate.mode === 'deployed' || candidate.mode === 'live-sync') &&
		typeof candidate.generation === 'string'
	);
}

export function runtimeHandoffChanged(
	baseline: RuntimeHandoffIdentity,
	observed: RuntimeHandoffIdentity
): boolean {
	return (
		baseline.watch &&
		observed.watch &&
		baseline.previewName === observed.previewName &&
		baseline.generation !== observed.generation
	);
}

export function startRuntimeHandoffWatcher(input: {
	baseline: RuntimeHandoffIdentity;
	fetch?: typeof globalThis.fetch;
	reload: () => void;
	intervalMs?: number;
}): () => void {
	if (!input.baseline.watch) return () => undefined;
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const intervalMs = input.intervalMs ?? 250;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const schedule = () => {
		if (!stopped) timer = setTimeout(probe, intervalMs);
	};
	const probe = async () => {
		try {
			const response = await fetchImpl(RUNTIME_HANDOFF_ENDPOINT, {
				cache: 'no-store',
				headers: { 'cache-control': 'no-cache' }
			});
			if (response.ok) {
				const observed: unknown = await response.json();
				if (isRuntimeHandoffIdentity(observed) && runtimeHandoffChanged(input.baseline, observed)) {
					stopped = true;
					input.reload();
					return;
				}
			}
		} catch {
			// A Service handoff can briefly reset connections; the next probe is authoritative.
		}
		schedule();
	};

	schedule();
	return () => {
		stopped = true;
		if (timer !== null) clearTimeout(timer);
	};
}

import type { RuntimeHandoffIdentity } from '$lib/types/runtime-handoff';

const RUNTIME_HANDOFF_ENDPOINT = '/api/runtime-handoff';

type VisibilityTarget = Pick<
	Document,
	'hidden' | 'addEventListener' | 'removeEventListener'
>;

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
	visibility?: VisibilityTarget;
}): () => void {
	if (!input.baseline.watch) return () => undefined;
	const fetchImpl = input.fetch ?? globalThis.fetch;
	const intervalMs = input.intervalMs ?? 750;
	const visibility =
		input.visibility ?? (typeof document === 'undefined' ? undefined : document);
	let stopped = false;
	let probing = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const clearTimer = () => {
		if (timer !== null) clearTimeout(timer);
		timer = null;
	};
	const schedule = (delay = intervalMs) => {
		if (stopped || visibility?.hidden) return;
		clearTimer();
		timer = setTimeout(() => void probe(), delay);
	};
	const probe = async () => {
		if (stopped || probing || visibility?.hidden) return;
		probing = true;
		try {
			const response = await fetchImpl(RUNTIME_HANDOFF_ENDPOINT, {
				cache: 'no-store',
				headers: { 'cache-control': 'no-cache' }
			});
			if (stopped || visibility?.hidden) return;
			if (response.ok) {
				const observed: unknown = await response.json();
				if (stopped || visibility?.hidden) return;
				if (isRuntimeHandoffIdentity(observed) && runtimeHandoffChanged(input.baseline, observed)) {
					stopped = true;
					visibility?.removeEventListener('visibilitychange', onVisibilityChange);
					input.reload();
					return;
				}
			}
		} catch {
			// A Service handoff can briefly reset connections; the next probe is authoritative.
		} finally {
			probing = false;
			schedule();
		}
	};
	const onVisibilityChange = () => {
		if (stopped) return;
		if (visibility?.hidden) {
			clearTimer();
			return;
		}
		clearTimer();
		void probe();
	};

	visibility?.addEventListener('visibilitychange', onVisibilityChange);
	schedule();
	return () => {
		stopped = true;
		clearTimer();
		visibility?.removeEventListener('visibilitychange', onVisibilityChange);
	};
}

import type { ServiceGraphPayload } from '$lib/types/service-graph';

export class ServiceGraphRequestError extends Error {
	constructor(
		message: string,
		readonly status: number | null = null
	) {
		super(message);
		this.name = 'ServiceGraphRequestError';
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isServiceGraphPayload(value: unknown): value is ServiceGraphPayload {
	if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return false;
	if (value.mode !== 'service' && value.mode !== 'step') return false;
	if (value.scope !== 'execution' && value.scope !== 'window') return false;
	return isRecord(value.meta) && Array.isArray(value.meta.warnings);
}

function responseMessage(value: unknown, fallback: string): string {
	if (!isRecord(value)) return fallback;
	for (const key of ['message', 'error']) {
		const candidate = value[key];
		if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
	}
	return fallback;
}

export async function fetchServiceGraphPayload(
	url: string,
	options: { signal?: AbortSignal; fetcher?: typeof fetch } = {}
): Promise<ServiceGraphPayload> {
	const response = await (options.fetcher ?? fetch)(url, { signal: options.signal });
	const text = await response.text();
	let body: unknown = null;
	if (text.trim()) {
		try {
			body = JSON.parse(text);
		} catch {
			if (response.ok) throw new ServiceGraphRequestError('Service graph returned invalid JSON');
		}
	}

	if (!response.ok) {
		throw new ServiceGraphRequestError(
			responseMessage(body, `Service graph request failed (${response.status})`),
			response.status
		);
	}
	if (!isServiceGraphPayload(body)) {
		throw new ServiceGraphRequestError('Service graph returned an invalid response', response.status);
	}
	return body;
}

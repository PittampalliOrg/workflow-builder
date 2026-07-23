import { randomUUID } from 'node:crypto';
import {
	devPreviewCaptureMappings,
	devPreviewCommands,
	resolveDevPreviewDescriptor
} from '$lib/server/workflows/dev-preview-registry';
import {
	resolveDevSyncCredentials,
	type DevSyncCredentialResolverOptions
} from '$lib/server/workflows/dev-sync-credentials';

/**
 * B5: host-side helpers for talking to a dev-preview pod's dev-sync-sidecar
 * (`/__status`, `/__run`). The BFF reaches the pod exactly the way the
 * existing `/__export` capture does (dev-preview.ts): direct pod IP + sync
 * port on the cluster pod network, authenticated with an execution/service
 * scoped receiver leaf (`x-sync-token` header). The pod address comes off the
 * persisted workspace-session row's `syncUrl` — never from caller input.
 *
 * Services in `plugin` sync mode (the Vite plugin serves only `/__sync` +
 * `/__export`) have no `/__status`//`/__run`; those degrade to a typed
 * failure the card renders as "sidecar status unavailable".
 */

export type SidecarStatus = {
	ok: boolean;
	service?: string;
	dest?: string;
	lastSyncAt?: string | null;
	lastSyncBytes?: number | null;
	lastSyncTimingsMs?: SidecarSyncTimings | null;
	frozen?: boolean;
	prepared?: boolean;
	preparedOperationId?: string | null;
	preparedAt?: string | null;
	frozenOperationId?: string | null;
	lastRun?: unknown;
	commands?: string[];
};

export type SidecarSyncTimings = {
	validation: number;
	staging: number;
	planning: number;
	commit: number;
	total: number;
};

export type SidecarResult<T> =
	| { ok: true; data: T }
	| {
			ok: false;
			reason: 'no-sidecar' | 'unreachable' | 'bad-response' | 'forbidden';
			message?: string;
	  };

export type SidecarRunOutput = {
	ok: boolean;
	cmd: string;
	exitCode: number | null;
	durationMs: number | null;
	truncated: boolean;
	output: string;
	/** Where the command ran (#40): "app" = the app container's exec bridge
	 * (the service's real toolchain), "sidecar" = the node-only sidecar (the
	 * explicit legacy fallback). null when it did not run or against an old sidecar. */
	executedIn: 'app' | 'sidecar' | null;
};

export type SidecarSyncOutput = {
	ok: boolean;
	status: number;
	bytes: number;
	body: unknown;
};

const STATUS_TIMEOUT_MS = 3_000;
const RUN_TIMEOUT_MS = 180_000;
const SYNC_TIMEOUT_MS = 180_000;
const SYNC_ERROR_DETAIL_LIMIT = 2_000;

function parseSyncTimings(raw: unknown): SidecarSyncTimings | null {
	if (!raw || typeof raw !== 'object') return null;
	const value = raw as Record<string, unknown>;
	const keys = ['validation', 'staging', 'planning', 'commit', 'total'] as const;
	if (
		keys.some(
			(key) =>
				typeof value[key] !== 'number' || !Number.isFinite(value[key]) || Number(value[key]) < 0
		)
	) {
		return null;
	}
	return Object.fromEntries(keys.map((key) => [key, value[key]])) as SidecarSyncTimings;
}

/** Derive the sidecar base URL from a persisted row's syncUrl (`http://ip:port/__sync`). */
export function sidecarBaseUrl(syncUrl: string | null | undefined): string | null {
	if (!syncUrl) return null;
	const trimmed = syncUrl.trim();
	if (!trimmed) return null;
	return trimmed.replace(/\/__sync\/?$/, '').replace(/\/+$/, '') || null;
}

/** Allowlisted `/__run` command names for a service (registry deps + testCommands).
 * Unknown services resolve to an empty allowlist (deny) instead of throwing. */
export function allowedSidecarCommands(service: string): string[] {
	try {
		const descriptor = resolveDevPreviewDescriptor(service);
		return Object.keys(devPreviewCommands(descriptor)).sort();
	} catch {
		return [];
	}
}

export async function fetchSidecarStatus(input: {
	syncUrl: string | null | undefined;
	executionId: string;
	service: string;
	credentialOptions?: DevSyncCredentialResolverOptions;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<SidecarResult<SidecarStatus>> {
	const base = sidecarBaseUrl(input.syncUrl);
	if (!base)
		return {
			ok: false,
			reason: 'no-sidecar',
			message: 'no sync endpoint recorded'
		};
	const doFetch = input.fetchImpl ?? fetch;
	let token: string;
	try {
		token = (
			await resolveDevSyncCredentials(
				{
					executionId: input.executionId,
					service: input.service
				},
				input.credentialOptions
			)
		).receiverToken;
	} catch (err) {
		return {
			ok: false,
			reason: 'forbidden',
			message: err instanceof Error ? err.message : String(err)
		};
	}
	let response: Response;
	try {
		response = await doFetch(`${base}/__status`, {
			headers: { 'x-sync-token': token },
			signal: AbortSignal.timeout(input.timeoutMs ?? STATUS_TIMEOUT_MS)
		});
	} catch (err) {
		return {
			ok: false,
			reason: 'unreachable',
			message: err instanceof Error ? err.message : String(err)
		};
	}
	if (response.status === 401)
		return { ok: false, reason: 'forbidden', message: 'sync token rejected' };
	if (!response.ok) {
		return {
			ok: false,
			reason: 'bad-response',
			message: `HTTP ${response.status}`
		};
	}
	try {
		const body = (await response.json()) as Record<string, unknown>;
		if (!body || typeof body !== 'object') throw new Error('non-object body');
		if (body.service !== 'dev-sync-sidecar') {
			// A plugin-mode dev server answering with app HTML/JSON — not a sidecar.
			return {
				ok: false,
				reason: 'no-sidecar',
				message: 'endpoint is not a dev-sync-sidecar (plugin sync mode?)'
			};
		}
		return {
			ok: true,
			data: {
				ok: body.ok === true,
				service: typeof body.service === 'string' ? body.service : undefined,
				dest: typeof body.dest === 'string' ? body.dest : undefined,
				lastSyncAt: typeof body.lastSyncAt === 'string' ? body.lastSyncAt : null,
				lastSyncBytes: typeof body.lastSyncBytes === 'number' ? body.lastSyncBytes : null,
				lastSyncTimingsMs: parseSyncTimings(body.lastSyncTimingsMs),
				frozen: body.frozen === true,
				prepared: body.prepared === true,
				preparedOperationId:
					typeof body.preparedOperationId === 'string' ? body.preparedOperationId : null,
				preparedAt: typeof body.preparedAt === 'string' ? body.preparedAt : null,
				frozenOperationId:
					typeof body.frozenOperationId === 'string' ? body.frozenOperationId : null,
				lastRun: body.lastRun ?? null,
				commands: Array.isArray(body.commands)
					? body.commands.filter((c): c is string => typeof c === 'string')
					: []
			}
		};
	} catch (err) {
		return {
			ok: false,
			reason: 'no-sidecar',
			message: err instanceof Error ? err.message : String(err)
		};
	}
}

export async function runSidecarCommand(input: {
	syncUrl: string | null | undefined;
	executionId: string;
	service: string;
	cmd: string;
	credentialOptions?: DevSyncCredentialResolverOptions;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<SidecarResult<SidecarRunOutput>> {
	const base = sidecarBaseUrl(input.syncUrl);
	if (!base)
		return {
			ok: false,
			reason: 'no-sidecar',
			message: 'no sync endpoint recorded'
		};
	const cmd = input.cmd.trim();
	// Defense in depth: the sidecar enforces its own DEV_SYNC_COMMANDS_JSON
	// allowlist, but the BFF refuses anything outside the registry's declared
	// command names before a request ever leaves the host.
	const allowed = allowedSidecarCommands(input.service);
	if (!allowed.includes(cmd)) {
		return {
			ok: false,
			reason: 'forbidden',
			message: `command '${cmd}' not in allowlist [${allowed.join(', ')}]`
		};
	}
	const doFetch = input.fetchImpl ?? fetch;
	let token: string;
	try {
		token = (
			await resolveDevSyncCredentials(
				{
					executionId: input.executionId,
					service: input.service
				},
				input.credentialOptions
			)
		).receiverToken;
	} catch (err) {
		return {
			ok: false,
			reason: 'forbidden',
			message: err instanceof Error ? err.message : String(err)
		};
	}
	let response: Response;
	try {
		response = await doFetch(`${base}/__run?cmd=${encodeURIComponent(cmd)}`, {
			method: 'POST',
			headers: { 'x-sync-token': token },
			signal: AbortSignal.timeout(input.timeoutMs ?? RUN_TIMEOUT_MS)
		});
	} catch (err) {
		return {
			ok: false,
			reason: 'unreachable',
			message: err instanceof Error ? err.message : String(err)
		};
	}
	if (response.status === 401)
		return { ok: false, reason: 'forbidden', message: 'sync token rejected' };
	let body: Record<string, unknown>;
	try {
		body = (await response.json()) as Record<string, unknown>;
		if (!body || typeof body !== 'object') throw new Error('non-object body');
	} catch (err) {
		return {
			ok: false,
			reason: 'bad-response',
			message: err instanceof Error ? err.message : String(err)
		};
	}
	if (!response.ok) {
		return {
			ok: false,
			reason: response.status >= 500 ? 'unreachable' : 'bad-response',
			message:
				typeof body.error === 'string'
					? body.error
					: `sidecar run dispatch failed with HTTP ${response.status}`
		};
	}
	// HTTP 200 means the command ran; a nonzero exit remains valid result data.
	return {
		ok: true,
		data: {
			ok: body.ok === true,
			cmd,
			exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
			durationMs: typeof body.durationMs === 'number' ? body.durationMs : null,
			truncated: body.truncated === true,
			output:
				typeof body.output === 'string'
					? body.output
					: typeof body.error === 'string'
						? body.error
						: '',
			executedIn:
				body.executedIn === 'app' || body.executedIn === 'sidecar' ? body.executedIn : null
		}
	};
}

export async function syncDevPreviewSource(input: {
	syncUrl: string | null | undefined;
	executionId: string;
	service: string;
	archive: ArrayBuffer | Uint8Array;
	credentialOptions?: DevSyncCredentialResolverOptions;
	contentType?: string | null;
	generation?: string;
	mode?: 'merge' | 'replace';
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
}): Promise<SidecarResult<SidecarSyncOutput>> {
	const syncUrl = input.syncUrl?.trim();
	if (!syncUrl)
		return {
			ok: false,
			reason: 'no-sidecar',
			message: 'no sync endpoint recorded'
		};
	const archive =
		input.archive instanceof Uint8Array ? input.archive : new Uint8Array(input.archive);
	const archiveBody = toArrayBuffer(archive);
	const doFetch = input.fetchImpl ?? fetch;
	let token: string;
	try {
		token = (
			await resolveDevSyncCredentials(
				{
					executionId: input.executionId,
					service: input.service
				},
				input.credentialOptions
			)
		).receiverToken;
	} catch (err) {
		return {
			ok: false,
			reason: 'forbidden',
			message: err instanceof Error ? err.message : String(err)
		};
	}
	const descriptor = resolveDevPreviewDescriptor(input.service);
	const roots = [
		...new Set(devPreviewCaptureMappings(descriptor).map((mapping) => mapping.from))
	].sort();
	let response: Response;
	try {
		response = await doFetch(syncUrl, {
			method: 'POST',
			headers: {
				'content-type': input.contentType?.trim() || 'application/gzip',
				'x-sync-generation': input.generation?.trim() || randomUUID(),
				'x-sync-mode': input.mode ?? 'merge',
				'x-sync-service': descriptor.service,
				'x-sync-roots': JSON.stringify(roots),
				'x-sync-token': token
			},
			body: new Blob([archiveBody]),
			signal: AbortSignal.timeout(input.timeoutMs ?? SYNC_TIMEOUT_MS)
		});
	} catch (err) {
		return {
			ok: false,
			reason: 'unreachable',
			message: err instanceof Error ? err.message : String(err)
		};
	}
	if (response.status === 401)
		return { ok: false, reason: 'forbidden', message: 'sync token rejected' };
	const body = await parseSyncResponse(response);
	if (!response.ok) {
		const detail = boundedSyncErrorDetail(body);
		return {
			ok: false,
			reason: 'bad-response',
			message: `HTTP ${response.status}${detail ? `: ${detail}` : ''}`
		};
	}
	return {
		ok: true,
		data: {
			ok: true,
			status: response.status,
			bytes: archive.byteLength,
			body
		}
	};
}

function boundedSyncErrorDetail(body: unknown): string | null {
	const raw =
		typeof body === 'string'
			? body
			: body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string'
				? ((body as Record<string, unknown>).error as string)
				: '';
	const detail = raw.trim();
	if (!detail) return null;
	return detail.length > SYNC_ERROR_DETAIL_LIMIT
		? `${detail.slice(0, SYNC_ERROR_DETAIL_LIMIT)}...`
		: detail;
}

async function parseSyncResponse(response: Response): Promise<unknown> {
	const contentType = response.headers.get('content-type') ?? '';
	try {
		if (contentType.includes('application/json')) return await response.json();
		const text = await response.text();
		return text.length > SYNC_ERROR_DETAIL_LIMIT
			? `${text.slice(0, SYNC_ERROR_DETAIL_LIMIT)}...`
			: text;
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}
